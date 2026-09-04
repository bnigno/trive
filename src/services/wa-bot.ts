// VENDEDORA DE IA no WhatsApp (Fase 5 / Onda 3): executa UM turno de conversa
// por evento 'wa.bot_turn' da fila. A IA nunca é fonte de fatos — preço,
// estoque, frete e pedido saem das ferramentas deste arquivo, que devolvem
// blocos pt-BR prontos. Regras duras: resposta idempotente por mensagem
// inbound (dedupe em wa_messages), transferência para humano SEMPRE audita e
// silencia o bot por 24h, e nada aqui toca o fluxo SAIR/opt-out (wa-inbound).
//
// Memória: o "caderninho" (src/core/bot/memory.ts) vive em
// wa_conversations.bot_state e entra no turno como primeira mensagem, fora do
// prompt de sistema — que se mantém idêntico entre turnos para o cache valer.
import { and, desc, eq, ilike, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { getAdapterMode } from "@/adapters/adapter-mode";
import {
  AssistantUnavailableError,
  type AssistantTurn,
  type BotChatMessage,
  type SalesAssistant,
} from "@/adapters/assistant";
import { getPaymentGateway } from "@/adapters/mercadopago";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  addNote,
  cartAdd,
  cartRemove,
  formatCartLines,
  parseBotState,
  renderContextNote,
  type BotCartItem,
  type BotState,
} from "@/core/bot/memory";
import {
  OPTION_LIST_MAX_OPTIONS,
  truncateOptionTitle,
} from "@/core/bot/option-list";
import {
  BOT_TOOL_INPUT_SCHEMAS,
  type BotToolInputs,
  type ToolExecutor,
} from "@/core/bot/tools";
import {
  isAddressUsable,
  summarizeRegistration,
  type SavedRegistration,
} from "@/core/bot/customer";
import {
  buildVariantMenu,
  colorOfVariant,
  formatVariantLines,
  pickImagePath,
} from "@/core/bot/variants";
import {
  buildBotSystemPrompt,
  DEFAULT_SELLER_NAME,
  truncateForWhatsApp,
} from "@/core/bot/prompt";
import { splitBotReply } from "@/core/bot/reply";
import { renderStoreMap } from "@/core/bot/store-map";
import { variantLabel } from "@/core/catalog/attributes";
import { deriveWaMessageOrigin } from "@/core/whatsapp/origin";
import {
  auditLog,
  categories,
  customerAddresses,
  customers,
  orders,
  priceVersions,
  products,
  productVariants,
  stockLevels,
  waConversations,
  waMessages,
} from "@/db/schema";
import { formatDateTimeSP } from "@/emails/templates";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { isValidCpf } from "@/lib/document";
import { formatCentsBRL } from "@/lib/money";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import {
  computeTotalWeightGrams,
  DEFAULT_ITEM_WEIGHT_GRAMS,
  getPublicProductBySlug,
  getStoreMap,
  listProductIdsWithVariant,
  listPublicProducts,
  publicImageUrl,
  quoteShipping,
  type PublicProductDetail,
  type PublicProductListItem,
  type ShippingQuote,
} from "@/services/store-catalog";
import {
  createStoreOrder,
  PriceChangedError,
  ServiceError,
  ShippingChangedError,
} from "@/services/store-orders";
import { ensurePaymentPreference, isMpEnabled } from "@/services/store-payments";
import {
  isWaEnabled,
  orderPublicUrl,
  sendMediaMessage,
  sendTemplateMessage,
  siteBaseUrl,
} from "@/services/wa-messaging";

// ---------------------------------------------------------------------------
// Constantes e tipos
// ---------------------------------------------------------------------------

const DEFAULT_BOT_MODEL = "claude-sonnet-5";
const DEFAULT_STORE_NAME = STORE_NAME_DEFAULT;
// 40 mensagens: uma compra com lista + foto + CEP + frete + cadastro passa
// fácil de 20, e a peça escolhida no começo saía da janela.
const HISTORY_LIMIT = 40;
const PAGE_SIZE = OPTION_LIST_MAX_OPTIONS;
const DESCRIPTION_MAX_CHARS = 700;
const HANDOFF_SILENCE_HOURS = 24;
// Pix manual tem ritmo humano (dono confere o banco): o prazo de reserva de
// 2h expiraria DEPOIS de o cliente pagar — estendemos para 24h quando menor.
const PIX_MANUAL_TTL_HOURS = 24;

export const BOT_UNAVAILABLE_REPLY =
  "Nosso atendimento automático está indisponível — já chamei a equipe 😉";
export const HANDOFF_COURTESY_REPLY =
  "Alguém da equipe vai te responder por aqui em breve! 🙋";

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "em rascunho",
  pending_payment: "aguardando pagamento",
  paid: "pagamento aprovado",
  preparing: "em preparação",
  shipped: "enviado",
  delivered: "entregue",
  canceled: "cancelado",
  refunded: "reembolsado",
};

/**
 * Mídia que uma ferramenta quer enviar ao cliente NESTE turno (lista tocável
 * ou foto). A ferramenta apenas EMITE via ctx.onAttachment; quem envia de fato
 * (com dedupe e melhor esforço) é o runBotTurn, antes do texto da IA.
 */
export type BotAttachment =
  | {
      kind: "option_list";
      message: string;
      title: string;
      buttonLabel: string;
      options: { id: string; title: string; description?: string }[];
    }
  | { kind: "image"; imageUrl: string; caption: string };

export type BotExecutorContext = {
  conversationId: string;
  phoneE164: string;
  customerId: string | null;
  /**
   * Id da última wa_message inbound do turno — base dos dedupes das
   * ferramentas com efeito externo (enviar_chave_pix, avisar_dono): o retry
   * do evento da fila reexecuta o turno inteiro e NÃO pode duplicar avisos.
   */
  lastInboundId: string;
  onAttachment?: (attachment: BotAttachment) => void;
  /**
   * Ensaio (playground do painel): nada com efeito externo ou de escrita
   * acontece — criar_pedido, enviar_chave_pix, avisar_dono e transferir
   * respondem um texto explicando que estão desligados no ensaio.
   */
  dryRun?: boolean;
};

export type RunBotTurnResult =
  | { replied: boolean; handedOff: boolean }
  | { skipped: string };

// ---------------------------------------------------------------------------
// isBotEnabled — toggle bot_enabled E WhatsApp funcional E (modo fake OU
// ANTHROPIC_API_KEY). Sem qualquer um deles, o inbound segue para o dono.
// ---------------------------------------------------------------------------

export async function isBotEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["bot_enabled"]);
  if (map["bot_enabled"] !== true) return false;
  if (!(await isWaEnabled(db))) return false;
  if (getAdapterMode() === "fake") return true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return typeof apiKey === "string" && apiKey.trim() !== "";
}

// ---------------------------------------------------------------------------
// Helpers de estado da conversa (o caderninho)
// ---------------------------------------------------------------------------

async function loadBotState(db: DbOrTx, conversationId: string): Promise<BotState> {
  const [row] = await db
    .select({ botState: waConversations.botState })
    .from(waConversations)
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  return parseBotState(row?.botState);
}

async function saveBotState(
  db: DbOrTx,
  conversationId: string,
  state: BotState,
): Promise<void> {
  await db
    .update(waConversations)
    .set({ botState: state, updatedAt: new Date() })
    .where(eq(waConversations.id, conversationId));
}

/** Lê, aplica a mudança e grava — o padrão de todo executor que lembra algo. */
async function updateBotState(
  db: DbOrTx,
  ctx: BotExecutorContext,
  change: (state: BotState) => BotState,
): Promise<BotState> {
  const current = await loadBotState(db, ctx.conversationId);
  const next = change(current);
  if (!ctx.dryRun) await saveBotState(db, ctx.conversationId, next);
  return next;
}

/**
 * Transfere a conversa para atendimento humano: status 'human', bot em
 * silêncio por 24h, audit (com o resumo para a equipe) e aviso ao dono via
 * outbox. Compartilhado entre a ferramenta transferir_para_atendente e o
 * fallback de IA indisponível.
 */
async function handOffToHuman(
  db: DbOrTx,
  ctx: { conversationId: string; phoneE164: string; lastInboundId: string },
  motivo: string,
  resumo?: string,
): Promise<void> {
  const now = new Date();
  const botDisabledUntil = new Date(
    now.getTime() + HANDOFF_SILENCE_HOURS * 60 * 60_000,
  );

  const state = await loadBotState(db, ctx.conversationId);
  await db
    .update(waConversations)
    .set({
      status: "human",
      botDisabledUntil,
      updatedAt: now,
      botState: {
        ...state,
        handoff: {
          motivo,
          ...(resumo ? { resumo } : {}),
          at: now.toISOString(),
        },
      },
    })
    .where(eq(waConversations.id, ctx.conversationId));

  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.bot_handoff",
    entityType: "wa_conversation",
    entityId: ctx.conversationId,
    after: {
      motivo,
      ...(resumo ? { resumo } : {}),
      botDisabledUntil: botDisabledUntil.toISOString(),
    },
    reason: motivo,
  });

  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    // Determinístico pela última inbound: o retry do turno (ou o rollback da
    // transação) nunca duplica o aviso ao dono.
    dedupeKey: `wa.handoff:${ctx.conversationId}:${ctx.lastInboundId}`,
    aggregateType: "wa_conversation",
    aggregateId: ctx.conversationId,
    payload: {
      phoneE164: ctx.phoneE164,
      body: [
        `🤖→👤 A vendedora passou a conversa com ${ctx.phoneE164} para você: ${motivo}.`,
        ...(resumo ? [resumo] : []),
        "Responda pelo painel ou aqui mesmo.",
      ].join("\n"),
      raw: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Executores das ferramentas
// ---------------------------------------------------------------------------

type ToolResult = { ok: boolean; text: string; endsTurn?: boolean };

const DRY_RUN_TEXT =
  "[Ensaio: esta ação fica desligada no teste do painel. Responda à cliente como se tivesse funcionado, sem inventar números.]";

function formatDeliveryDays(min: number, max: number): string {
  return min === max ? `${min} dias úteis` : `${min} a ${max} dias úteis`;
}

/**
 * Texto que uma mensagem antiga assume no histórico enviado ao modelo.
 *
 * O body de um option_list é gravado JÁ RENDERIZADO ("Toque abaixo…" + uma
 * linha por produto com preço) porque é o que a thread do admin exibe. Só que
 * isso, no histórico, é uma lista pronta convidando a ser copiada — e o modelo
 * copia: em 26/08 ele reemitiu a lista inteira como texto puro, sem chamar
 * listar_produtos, e o cliente ficou sem os botões (a lista interativa só sai
 * quando a ferramenta roda de verdade). Trocar pelo marcador remove a cola:
 * para mostrar produtos, o modelo é OBRIGADO a chamar a ferramenta.
 */
export function historyTextFor(kind: string, body: string): string {
  if (kind === "option_list") {
    return "[lista tocável do catálogo enviada ao cliente]";
  }
  if (kind === "image") {
    return `[foto enviada ao cliente] ${body}`;
  }
  return body;
}

/**
 * Mensagem de saída que NÃO foi a vendedora (resposta manual da equipe,
 * aviso automático de pedido, ack de SAIR) entra no histórico com a origem
 * marcada — senão o modelo "assume" promessas do dono ou repete templates.
 */
export function historyTextForOutbound(input: {
  kind: string;
  body: string;
  dedupeKey: string | null;
  templateKey: string | null;
}): string {
  const origin = deriveWaMessageOrigin({
    direction: "outbound",
    dedupeKey: input.dedupeKey,
    templateKey: input.templateKey,
  });
  const text = historyTextFor(input.kind, input.body);
  if (origin === "manual") {
    return `[mensagem enviada pela equipe da loja, não por você] ${text}`;
  }
  if (origin === "auto") {
    return `[aviso automático da loja] ${text}`;
  }
  return text;
}

function formatPriceRange(fromCents: number, toCents: number): string {
  return fromCents === toCents
    ? formatCentsBRL(fromCents)
    : `a partir de ${formatCentsBRL(fromCents)}`;
}

/** Categoria por slug exato ou nome aproximado; null quando não existe. */
async function resolveCategorySlug(
  db: DbOrTx,
  term: string,
): Promise<string | null> {
  const trimmed = term.trim();
  if (trimmed === "") return null;
  const [bySlug] = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.slug, trimmed.toLowerCase()))
    .limit(1);
  if (bySlug) return bySlug.slug;
  const [byName] = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(ilike(categories.name, `%${trimmed}%`))
    .limit(1);
  return byName?.slug ?? null;
}

async function execListarProdutos(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["listar_produtos"],
): Promise<ToolResult> {
  const busca = input.busca?.trim();
  const filtros: string[] = [];

  let categorySlug: string | undefined;
  if (input.categoria?.trim()) {
    const slug = await resolveCategorySlug(db, input.categoria);
    if (!slug) {
      return {
        ok: false,
        text: `Não existe a categoria "${input.categoria}". Use uma das categorias da PLANTA DA LOJA ou busque por palavra (busca).`,
      };
    }
    categorySlug = slug;
    filtros.push(`categoria ${input.categoria.trim()}`);
  }
  if (busca) filtros.push(`"${busca}"`);

  let items: PublicProductListItem[] = await listPublicProducts(db, {
    ...(busca ? { q: busca, includeDescription: true } : {}),
    ...(categorySlug ? { categorySlug } : {}),
    limit: 200,
  });

  const byAttribute = await listProductIdsWithVariant(db, {
    ...(input.cor ? { cor: input.cor } : {}),
    ...(input.tamanho ? { tamanho: input.tamanho } : {}),
  });
  if (byAttribute) {
    items = items.filter((item) => byAttribute.has(item.id));
    if (input.cor) filtros.push(`cor ${input.cor.trim()}`);
    if (input.tamanho) filtros.push(`tamanho ${input.tamanho.trim()}`);
  }
  if (input.preco_maximo_reais !== undefined) {
    const tetoCents = input.preco_maximo_reais * 100;
    items = items.filter((item) => item.priceFromCents <= tetoCents);
    filtros.push(`até ${formatCentsBRL(tetoCents)}`);
  }

  const descricaoFiltro = filtros.length > 0 ? ` (${filtros.join(", ")})` : "";
  if (items.length === 0) {
    return {
      ok: true,
      text: filtros.length > 0
        ? `Nenhuma peça encontrada${descricaoFiltro}. Tente afrouxar um filtro (outra cor, outro tamanho, sem teto de preço) ou busque por outra palavra — e diga isso à cliente com honestidade.`
        : "O catálogo está vazio no momento — em breve teremos novidades!",
    };
  }

  const pagina = input.pagina ?? 1;
  const totalPaginas = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const paginaEfetiva = Math.min(pagina, totalPaginas);
  const inicio = (paginaEfetiva - 1) * PAGE_SIZE;
  const page = items.slice(inicio, inicio + PAGE_SIZE);

  const lines = page.map((item) => {
    const preco = formatPriceRange(item.priceFromCents, item.priceToCents);
    const categoria = item.categoryName ? ` · ${item.categoryName}` : "";
    return `• ${item.name}${categoria} — ${preco}${item.available ? "" : " (esgotado)"}`;
  });
  lines.unshift(
    `${items.length} ${items.length === 1 ? "peça encontrada" : "peças encontradas"}${descricaoFiltro}${
      totalPaginas > 1
        ? ` — mostrando ${inicio + 1} a ${inicio + page.length} (página ${paginaEfetiva} de ${totalPaginas}; passe pagina: ${paginaEfetiva + 1} para as próximas)`
        : ""
    }.`,
  );

  if (ctx.onAttachment) {
    const map = await getSettingsMap(db, ["store_name"]);
    const title =
      typeof map["store_name"] === "string" && map["store_name"].trim() !== ""
        ? map["store_name"].trim()
        : "Nossas peças";
    ctx.onAttachment({
      kind: "option_list",
      message:
        totalPaginas > 1
          ? `Toque abaixo e veja o catálogo 👇 (${inicio + 1}–${inicio + page.length} de ${items.length})`
          : "Toque abaixo e veja o catálogo 👇",
      title,
      buttonLabel: "Ver o catálogo",
      options: page.map((item) => ({
        id: `produto:${item.slug}`,
        title: truncateOptionTitle(item.name),
        description: formatPriceRange(item.priceFromCents, item.priceToCents),
      })),
    });
    lines.push(
      "[A lista tocável do catálogo foi enviada ao cliente. Responda em 1 ou 2 frases curtas: comente até 3 peças com um motivo real cada e convide a tocar em «Ver o catálogo» — NÃO repita a lista de preços e NUNCA chame isso de menu ou cardápio: é o catálogo.]",
    );
  }
  return { ok: true, text: lines.join("\n") };
}

/**
 * Produto resolvido + a variante EXATA quando o cliente falou por SKU (é o
 * caso do toque na lista de variações): é dela que sai a cor da foto.
 */
type ResolvedProduct =
  | { kind: "found"; detail: PublicProductDetail; matchedSku: string | null }
  | { kind: "ambiguous"; candidates: PublicProductListItem[] }
  | { kind: "none" };

/**
 * Resolve por slug exato (aceita o id 'produto:<slug>' da lista), depois SKU
 * exato (sem caixa), depois nome aproximado. Mais de uma peça com o termo no
 * nome NÃO escolhe em silêncio: devolve as candidatas para o modelo perguntar.
 */
async function resolveProductDetail(
  db: DbOrTx,
  term: string,
): Promise<ResolvedProduct> {
  let trimmed = term.trim();
  if (trimmed.startsWith("produto:")) trimmed = trimmed.slice("produto:".length);
  if (trimmed === "") return { kind: "none" };

  const bySlug = await getPublicProductBySlug(db, trimmed.toLowerCase());
  if (bySlug) return { kind: "found", detail: bySlug, matchedSku: null };

  const [bySku] = await db
    .select({ slug: products.slug, sku: productVariants.sku })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        ilike(productVariants.sku, trimmed),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);
  if (bySku) {
    const detail = await getPublicProductBySlug(db, bySku.slug);
    if (detail) return { kind: "found", detail, matchedSku: bySku.sku };
  }

  const list = await listPublicProducts(db, { limit: 200 });
  const lowered = trimmed.toLowerCase();
  const exact = list.filter((p) => p.name.toLowerCase() === lowered);
  const contains =
    exact.length > 0
      ? exact
      : list.filter((p) => p.name.toLowerCase().includes(lowered));
  const matches =
    contains.length > 0
      ? contains
      : list.filter((p) => lowered.includes(p.name.toLowerCase()));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  const detail = await getPublicProductBySlug(db, matches[0].slug);
  return detail ? { kind: "found", detail, matchedSku: null } : { kind: "none" };
}

async function execDetalharProduto(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["detalhar_produto"],
): Promise<ToolResult> {
  const resolved = await resolveProductDetail(db, input.produto);
  if (resolved.kind === "none") {
    return {
      ok: false,
      text: `Não encontrei a peça "${input.produto}". Use listar_produtos para ver o catálogo disponível.`,
    };
  }
  if (resolved.kind === "ambiguous") {
    return {
      ok: true,
      text: [
        `Há ${resolved.candidates.length} peças com "${input.produto}" no nome — pergunte à cliente qual ela quer (ou chame de novo com o slug exato):`,
        ...resolved.candidates
          .slice(0, 8)
          .map(
            (item) =>
              `• ${item.name} (slug ${item.slug}) — ${formatPriceRange(item.priceFromCents, item.priceToCents)}${item.available ? "" : " (esgotado)"}`,
          ),
      ].join("\n"),
    };
  }
  const { detail, matchedSku } = resolved;
  const axes = detail.attributesSchema;

  // Cor definida na conversa: a que o modelo passou ou, quando o cliente
  // tocou numa variação da lista, a da própria variante do SKU resolvido.
  const matchedVariant =
    matchedSku === null
      ? undefined
      : detail.variants.find(
          (variant) => variant.sku.toLowerCase() === matchedSku.toLowerCase(),
        );
  const chosenColor =
    input.cor?.trim() ||
    (matchedVariant ? colorOfVariant(matchedVariant.attributes, axes) : null);

  // Peça em vista no caderninho: o próximo turno sabe do que a conversa fala.
  await updateBotState(db, ctx, (state) => ({
    ...state,
    focus: { slug: detail.slug, nome: detail.name, cor: chosenColor ?? null },
  }));

  // Foto da cor escolhida; sem foto daquela cor, cai na genérica.
  let photoEmitted = false;
  const imagePath = pickImagePath(detail.images, chosenColor);
  if (imagePath && ctx.onAttachment) {
    let imageUrl: string | null = null;
    try {
      imageUrl = publicImageUrl(imagePath);
    } catch {
      // NEXT_PUBLIC_SUPABASE_URL ausente (ex.: teste): segue sem foto.
      imageUrl = null;
    }
    if (imageUrl) {
      const priceCentsList = detail.variants.map((variant) => variant.priceCents);
      const preco = formatPriceRange(
        Math.min(...priceCentsList),
        Math.max(...priceCentsList),
      );
      const nome = chosenColor ? `${detail.name} (${chosenColor})` : detail.name;
      ctx.onAttachment({
        kind: "image",
        imageUrl,
        caption: `${nome} — ${preco}`,
      });
      photoEmitted = true;
    }
  }

  // Lista tocável das variações, espelhando a de produtos ('produto:<slug>').
  // Quando o produto veio POR SKU, o cliente já escolheu a combinação (foi ele
  // quem tocou na lista): reoferecer só atrapalha.
  let menuEmitted = false;
  if (ctx.onAttachment && matchedSku === null) {
    const menu = buildVariantMenu(detail.name, detail.variants, axes);
    if (menu) {
      ctx.onAttachment({ kind: "option_list", ...menu });
      menuEmitted = true;
    }
  }

  const lines = [detail.name];
  const meta = [
    ...(detail.categoryName ? [`Categoria: ${detail.categoryName}`] : []),
    ...(detail.brand ? [`Marca: ${detail.brand}`] : []),
  ];
  if (meta.length > 0) lines.push(meta.join(" · "));
  const description = detail.description?.trim();
  if (description) {
    lines.push(
      description.length > DESCRIPTION_MAX_CHARS
        ? `${description.slice(0, DESCRIPTION_MAX_CHARS).trimEnd()}…`
        : description,
    );
  } else {
    lines.push(
      "[Sem descrição cadastrada: não afirme tecido, caimento ou medidas — diga que confere com a equipe se a cliente perguntar.]",
    );
  }
  // Promoção "de/por" quando todas as combinações têm o mesmo preço anterior.
  const compareAt = detail.variants[0]?.compareAtPriceCents ?? null;
  if (
    compareAt !== null &&
    detail.variants.every(
      (variant) =>
        variant.compareAtPriceCents === compareAt &&
        variant.priceCents < compareAt,
    )
  ) {
    lines.push(
      `Promoção: de ${formatCentsBRL(compareAt)} por ${formatCentsBRL(detail.variants[0].priceCents)}.`,
    );
  }
  lines.push(...formatVariantLines(detail.variants, axes));
  if (detail.variants.every((variant) => variant.availableQty === 0)) {
    lines.push(
      "Atenção: esta peça está esgotada no momento. Ofereça outra parecida do catálogo ou anote (anotar + avisar_dono) para avisar quando voltar.",
    );
  }
  if (photoEmitted) {
    lines.push(
      chosenColor
        ? `[A foto de ${chosenColor} foi enviada ao cliente.]`
        : "[A foto da peça foi enviada ao cliente.]",
    );
  }
  if (menuEmitted) {
    lines.push(
      "[A lista tocável de cores e tamanhos foi enviada ao cliente. Responda em 1 frase curta convidando a tocar na opção desejada — NÃO repita a lista de variações.]",
    );
  }
  return { ok: true, text: lines.join("\n") };
}

/** Variante vendável por SKU (case-insensitive) com o preço ATIVO de agora. */
async function resolveVariantBySku(db: DbOrTx, sku: string) {
  const [row] = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      name: products.name,
      attributes: productVariants.attributes,
      attributesSchema: products.attributesSchema,
      weightGrams: productVariants.weightGrams,
      priceCents: priceVersions.priceCents,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.status, "active"),
        isNull(products.deletedAt),
      ),
    )
    .innerJoin(
      priceVersions,
      and(
        eq(priceVersions.productVariantId, productVariants.id),
        eq(priceVersions.status, "active"),
      ),
    )
    .where(
      and(
        ilike(productVariants.sku, sku),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Disponível agora (on_hand - reserved) da variante, 0 se não houver linha. */
async function availableQtyOf(db: DbOrTx, variantId: string): Promise<number> {
  const [row] = await db
    .select({ onHand: stockLevels.onHand, reserved: stockLevels.reserved })
    .from(stockLevels)
    .where(eq(stockLevels.productVariantId, variantId))
    .limit(1);
  if (!row) return 0;
  return Math.max(0, row.onHand - row.reserved);
}

async function execAdicionarASacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["adicionar_a_sacola"],
): Promise<ToolResult> {
  const variant = await resolveVariantBySku(db, input.sku);
  if (!variant) {
    return {
      ok: false,
      text: `Não encontrei o SKU "${input.sku}" no catálogo. Confirme a peça com detalhar_produto antes de pôr na sacola.`,
    };
  }
  const available = await availableQtyOf(db, variant.variantId);
  const axes = (variant.attributesSchema ?? []) as string[];
  const variacao = variantLabel(
    (variant.attributes ?? {}) as Record<string, string>,
    axes,
  );
  const rotulo = variacao ? `${variant.name} (${variacao})` : variant.name;
  if (available < input.quantidade) {
    return {
      ok: false,
      text:
        available === 0
          ? `${rotulo} está esgotada agora. Ofereça outra cor ou tamanho disponível (detalhar_produto) ou anote para avisar quando voltar.`
          : `${rotulo} tem só ${available} ${available === 1 ? "unidade" : "unidades"} disponível — pedi ${input.quantidade}. Ajuste a quantidade com a cliente.`,
    };
  }

  const item: BotCartItem = {
    sku: variant.sku,
    quantidade: input.quantidade,
    nome: variant.name,
    variacao,
    precoCents: variant.priceCents,
  };
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    cart: cartAdd(current.cart, item),
    // Sacola mudou: a cotação anterior valia para outro peso.
    lastQuotes: undefined,
    chosenRateId: undefined,
  }));
  return {
    ok: true,
    text: [
      `Adicionei ${input.quantidade}× ${rotulo} à sacola.`,
      ...formatCartLines(state.cart),
      "[Se a sacola tiver tudo, siga para o CEP e cotar_frete. Sugira UMA peça que completa o look só depois do pedido fechado.]",
    ].join("\n"),
  };
}

async function execVerSacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<ToolResult> {
  const state = await loadBotState(db, ctx.conversationId);
  return { ok: true, text: formatCartLines(state.cart).join("\n") };
}

async function execRemoverDaSacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["remover_da_sacola"],
): Promise<ToolResult> {
  const before = await loadBotState(db, ctx.conversationId);
  const existed = (before.cart ?? []).some(
    (item) => item.sku.toLowerCase() === input.sku.trim().toLowerCase(),
  );
  if (!existed) {
    return {
      ok: false,
      text: `O SKU "${input.sku}" não está na sacola.\n${formatCartLines(before.cart).join("\n")}`,
    };
  }
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    cart: cartRemove(current.cart, input.sku),
    lastQuotes: undefined,
    chosenRateId: undefined,
  }));
  return {
    ok: true,
    text: ["Tirei da sacola.", ...formatCartLines(state.cart)].join("\n"),
  };
}

async function cartWeightGrams(db: DbOrTx, cart: readonly BotCartItem[]): Promise<number> {
  const skus = cart.map((item) => item.sku);
  const variants = await db
    .select({ sku: productVariants.sku, weightGrams: productVariants.weightGrams })
    .from(productVariants)
    .where(inArray(productVariants.sku, skus));
  const weightBySku = new Map(variants.map((v) => [v.sku, v.weightGrams]));
  return computeTotalWeightGrams(
    cart.map((item) => ({
      weightGrams: weightBySku.get(item.sku) ?? null,
      quantity: item.quantidade,
    })),
  );
}

async function execCotarFrete(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["cotar_frete"],
): Promise<ToolResult> {
  const state = await loadBotState(db, ctx.conversationId);
  const cart = state.cart ?? [];

  // Com peças na sacola, o peso é real; sem sacola, cotamos com o peso
  // padrão de 1 peça e dizemos com honestidade que é estimativa.
  const isEstimate = cart.length === 0;
  const totalWeightGrams = isEstimate
    ? DEFAULT_ITEM_WEIGHT_GRAMS
    : await cartWeightGrams(db, cart);

  const quotes = await quoteShipping(db, { cep: input.cep, totalWeightGrams });
  if (quotes.length === 0) {
    return {
      ok: false,
      text: "Não entregamos para este CEP no momento. Confira se o CEP está correto, por favor.",
    };
  }

  await updateBotState(db, ctx, (current) => ({
    ...current,
    lastCep: input.cep,
    lastQuotes: quotes,
    chosenRateId: quotes.length === 1 ? quotes[0].rateId : undefined,
  }));

  const lines = quotes.map(
    (quote, index) =>
      `${index + 1}. ${quote.name} — ${formatCentsBRL(quote.priceCents)} (${formatDeliveryDays(quote.deliveryDaysMin, quote.deliveryDaysMax)})`,
  );
  if (isEstimate) {
    lines.push("Estimativa para 1 peça — o valor final aparece no resumo do pedido.");
  }
  if (quotes.length > 1) {
    lines.push(
      "[Pergunte à cliente qual opção ela prefere e passe a escolha em criar_pedido (campo frete).]",
    );
  }
  return { ok: true, text: lines.join("\n") };
}

/**
 * Cadastro já salvo para este telefone: o cliente mais recente com o número,
 * mais o endereço padrão (ou o último cadastrado).
 *
 * Cliente anonimizado por LGPD é IGNORADO de propósito — quem pediu para ser
 * esquecido não volta como sugestão de preenchimento.
 */
async function loadSavedRegistration(
  db: DbOrTx,
  phoneE164: string,
): Promise<SavedRegistration | null> {
  const [customer] = await db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      documentNumber: customers.documentNumber,
    })
    .from(customers)
    .where(
      and(
        eq(customers.phoneE164, phoneE164),
        isNull(customers.deletedAt),
        isNull(customers.anonymizedAt),
      ),
    )
    .orderBy(desc(customers.updatedAt))
    .limit(1);
  if (!customer) return null;

  const [address] = await db
    .select({
      postalCode: customerAddresses.postalCode,
      street: customerAddresses.street,
      number: customerAddresses.number,
      complement: customerAddresses.complement,
      district: customerAddresses.district,
      city: customerAddresses.city,
      state: customerAddresses.state,
    })
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, customer.id))
    .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.createdAt))
    .limit(1);

  return {
    fullName: customer.fullName,
    documentDigits: customer.documentNumber,
    address: address ?? null,
  };
}

async function execBuscarCadastro(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<ToolResult> {
  const registration = await loadSavedRegistration(db, ctx.phoneE164);
  if (!registration) {
    return {
      ok: true,
      text: "Este telefone ainda não tem cadastro — é a primeira compra dele por aqui. Colete os dados normalmente, um por vez.\n\n[NUNCA diga ao cliente que a loja não guarda dados: guardamos, este número é que ainda não tem cadastro.]",
    };
  }
  return { ok: true, text: summarizeRegistration(registration) };
}

/** Dados pessoais do pedido, vindos do cadastro salvo OU do que o bot coletou. */
type OrderIdentity = {
  fullName: string;
  documentDigits: string;
  postalCode: string;
  street: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  state: string;
};

/**
 * A opção de frete que a cliente escolheu, entre as cotações REAIS de agora:
 * pelo nome ("SEDEX"), pelo número da lista ("2") ou pelo id já escolhido no
 * caderninho. Sem escolha reconhecível e com mais de uma opção: null, e o
 * executor pede a escolha em vez de decidir sozinho.
 */
function pickChosenQuote(
  quotes: readonly ShippingQuote[],
  input: string | undefined,
  chosenRateId: string | undefined,
): ShippingQuote | null {
  if (quotes.length === 1) return quotes[0];
  // Opções com o mesmo nome (duas faixas "PAC") não são uma escolha real:
  // vale a mais barata, que é a primeira (quoteShipping ordena por preço).
  if (new Set(quotes.map((quote) => quote.name.toLowerCase())).size === 1) {
    return quotes[0];
  }
  const term = input?.trim().toLowerCase();
  if (term) {
    const byIndex = /^\d+$/.test(term) ? quotes[Number(term) - 1] : undefined;
    if (byIndex) return byIndex;
    const byName =
      quotes.find((quote) => quote.name.toLowerCase() === term) ??
      quotes.find((quote) => quote.name.toLowerCase().includes(term)) ??
      quotes.find((quote) => term.includes(quote.name.toLowerCase()));
    if (byName) return byName;
  }
  if (chosenRateId) {
    const byId = quotes.find((quote) => quote.rateId === chosenRateId);
    if (byId) return byId;
  }
  return null;
}

async function execCriarPedido(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["criar_pedido"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  let identity: OrderIdentity;

  if (input.usar_cadastro_salvo) {
    // Caminho do cliente recorrente: os dados REAIS saem do banco, então o CPF
    // nunca passa pelo modelo nem por uma mensagem de WhatsApp.
    const registration = await loadSavedRegistration(db, ctx.phoneE164);
    if (!registration || !isAddressUsable(registration.address)) {
      return {
        ok: false,
        text: "Não consegui reaproveitar o cadastro deste telefone (não existe ou está sem endereço completo). Colete nome, CPF e endereço com o cliente, um dado por vez, e chame criar_pedido com os campos preenchidos.",
      };
    }
    const address = registration.address;
    identity = {
      fullName: registration.fullName,
      documentDigits: (registration.documentDigits ?? "").replace(/\D/g, ""),
      postalCode: (address?.postalCode ?? "").replace(/\D/g, ""),
      street: address?.street ?? "",
      number: address?.number ?? "",
      ...(address?.complement ? { complement: address.complement } : {}),
      district: address?.district ?? "",
      city: address?.city ?? "",
      state: address?.state ?? "",
    };
  } else {
    // O superRefine de criarPedidoSchema já garantiu que todos vieram; o
    // fallback vazio existe só para o TypeScript estreitar os opcionais.
    identity = {
      fullName: input.nome_completo ?? "",
      documentDigits: input.cpf ?? "",
      postalCode: input.cep ?? "",
      street: input.rua ?? "",
      number: input.numero ?? "",
      ...(input.complemento !== undefined ? { complement: input.complemento } : {}),
      district: input.bairro ?? "",
      city: input.cidade ?? "",
      state: input.uf ?? "",
    };
  }

  // CPF com dígito verificador válido — a nota fiscal depende disso.
  if (!isValidCpf(identity.documentDigits)) {
    return {
      ok: false,
      text: "CPF inválido — confira os 11 dígitos com o cliente e tente de novo.",
    };
  }

  // Itens: os passados explicitamente ou, no caminho normal, a sacola.
  const state = await loadBotState(db, ctx.conversationId);
  const requested =
    input.itens ??
    (state.cart ?? []).map((item) => ({ sku: item.sku, quantidade: item.quantidade }));
  if (requested.length === 0) {
    return {
      ok: false,
      text: "A sacola está vazia. Confirme a peça com detalhar_produto e coloque-a com adicionar_a_sacola antes de fechar o pedido.",
    };
  }

  // Resolve cada SKU no catálogo vendável com o preço ativo de AGORA.
  const resolved: {
    variantId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    weightGrams: number | null;
  }[] = [];
  for (const item of requested) {
    const variant = await resolveVariantBySku(db, item.sku);
    if (!variant) {
      return {
        ok: false,
        text: `Não encontrei o SKU "${item.sku}" no catálogo. Confirme a peça com detalhar_produto antes de fechar o pedido.`,
      };
    }
    resolved.push({
      variantId: variant.variantId,
      sku: variant.sku,
      name: variant.name,
      quantity: item.quantidade,
      unitPriceCents: variant.priceCents,
      weightGrams: variant.weightGrams,
    });
  }

  // Frete: recota com o peso real e usa a opção que a CLIENTE escolheu.
  const totalWeightGrams = computeTotalWeightGrams(
    resolved.map((r) => ({ weightGrams: r.weightGrams, quantity: r.quantity })),
  );
  const quotes = await quoteShipping(db, {
    cep: identity.postalCode,
    totalWeightGrams,
  });
  if (quotes.length === 0) {
    return {
      ok: false,
      text: "Não entregamos para este CEP no momento. Confira se o CEP está correto, por favor.",
    };
  }
  const chosen = pickChosenQuote(quotes, input.frete, state.chosenRateId);
  if (!chosen) {
    return {
      ok: false,
      text: [
        "Há mais de uma opção de entrega e a escolha da cliente não veio (campo frete). Pergunte qual ela prefere e chame de novo:",
        ...quotes.map(
          (quote, index) =>
            `${index + 1}. ${quote.name} — ${formatCentsBRL(quote.priceCents)} (${formatDeliveryDays(quote.deliveryDaysMin, quote.deliveryDaysMax)})`,
        ),
      ].join("\n"),
    };
  }

  const isCash = input.forma_de_pagamento === "dinheiro_na_entrega";

  let created;
  try {
    created = await createStoreOrder(db, {
      channel: "whatsapp",
      paymentMethod: isCash ? "cash" : "online",
      customer: {
        fullName: identity.fullName,
        document: identity.documentDigits,
        // Telefone é SEMPRE o da conversa — nunca um número ditado ao bot.
        phone: ctx.phoneE164,
        marketingOptIn: true,
      },
      address: {
        postalCode: identity.postalCode,
        street: identity.street,
        number: identity.number,
        ...(identity.complement !== undefined
          ? { complement: identity.complement }
          : {}),
        district: identity.district,
        city: identity.city,
        state: identity.state,
      },
      items: resolved.map((r) => ({
        variantId: r.variantId,
        quantity: r.quantity,
        expectedUnitPriceCents: r.unitPriceCents,
      })),
      shippingRateId: chosen.rateId,
      expectedShippingCents: chosen.priceCents,
      ...(input.cupom !== undefined && input.cupom.trim() !== ""
        ? { couponCode: input.cupom }
        : {}),
    });
  } catch (error) {
    // Erros de negócio (preço mudou, estoque, cupom, frete) voltam com a
    // mensagem pt-BR do serviço para o modelo explicar ao cliente.
    if (
      error instanceof PriceChangedError ||
      error instanceof ShippingChangedError ||
      error instanceof ServiceError
    ) {
      return { ok: false, text: error.message };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        text: `Dados inválidos: ${error.issues[0]?.message ?? "confira os dados informados."}`,
      };
    }
    throw error;
  }

  // Vincula o cliente do pedido à conversa (histórico e opt-in coerentes) e
  // esvazia a sacola: o pedido é o dono das peças agora.
  const [orderRow] = await db
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.id, created.orderId))
    .limit(1);
  await db
    .update(waConversations)
    .set({
      ...(orderRow ? { customerId: orderRow.customerId } : {}),
      botState: {
        ...state,
        cart: [],
        lastQuotes: undefined,
        chosenRateId: undefined,
        lastOrderNumber: created.orderNumber,
      },
      updatedAt: new Date(),
    })
    .where(eq(waConversations.id, ctx.conversationId));

  // Link de pagamento: Mercado Pago quando ligado; senão a página pública do
  // pedido. Falha ao criar a preference NÃO derruba o pedido já criado.
  // Dinheiro na entrega NÃO cria preference nem mostra link de pagamento.
  let paymentLine = isCash
    ? `Acompanhe seu pedido: ${orderPublicUrl(created.publicToken)}`
    : `Acompanhe e pague: ${orderPublicUrl(created.publicToken)}`;
  if (!isCash && (await isMpEnabled(db))) {
    try {
      const preference = await ensurePaymentPreference(db, getPaymentGateway(), {
        orderId: created.orderId,
      });
      paymentLine = `Pague aqui: ${preference.initPointUrl}`;
    } catch (error) {
      console.warn(
        `[wa-bot] Falha ao criar preference MP do pedido ${created.orderId}; usando link público.`,
        error,
      );
    }
  }

  const subtotalCents = resolved.reduce(
    (sum, r) => sum + r.unitPriceCents * r.quantity,
    0,
  );
  const discountCents = subtotalCents + chosen.priceCents - created.totalCents;

  const lines = [
    `Pedido #${created.orderNumber} criado! 🎉`,
    ...resolved.map(
      (r) =>
        `• ${r.quantity}× ${r.name} — ${formatCentsBRL(r.unitPriceCents * r.quantity)}`,
    ),
    `Frete (${chosen.name}): ${formatCentsBRL(chosen.priceCents)}`,
    ...(discountCents > 0 ? [`Desconto: -${formatCentsBRL(discountCents)}`] : []),
    `TOTAL: ${formatCentsBRL(created.totalCents)}`,
    ...(isCash
      ? ["Pagamento em dinheiro na entrega — vamos combinar a entrega por aqui."]
      : []),
    paymentLine,
    // Sem linha de reserva no cash: pedido em dinheiro não expira (due NULL).
    ...(created.paymentDueAt !== null
      ? [
          `Reserva garantida até ${formatDateTimeSP(created.paymentDueAt)} (horário de Brasília).`,
        ]
      : []),
  ];
  return { ok: true, text: lines.join("\n") };
}

/**
 * Cliente DESTA conversa: vínculo direto, senão o dono do telefone. Base da
 * segurança de status_do_pedido e enviar_chave_pix — nunca cruzar conversas.
 */
async function resolveConversationCustomerId(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<string | null> {
  if (ctx.customerId) return ctx.customerId;
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(eq(customers.phoneE164, ctx.phoneE164), isNull(customers.deletedAt)),
    )
    .limit(1);
  return customer?.id ?? null;
}

async function execStatusDoPedido(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["status_do_pedido"],
): Promise<ToolResult> {
  // Segurança: só pedidos do cliente DESTA conversa (vínculo ou telefone).
  const customerId = await resolveConversationCustomerId(db, ctx);
  if (!customerId) {
    return {
      ok: false,
      text: "Ainda não encontrei pedidos para este número de WhatsApp. Se o pedido foi feito com outro telefone, posso chamar a equipe.",
    };
  }

  const conditions = [eq(orders.customerId, customerId)];
  if (input.numero_do_pedido !== undefined) {
    conditions.push(eq(orders.orderNumber, input.numero_do_pedido));
  }
  const [order] = await db
    .select({
      orderNumber: orders.orderNumber,
      status: orders.status,
      trackingCode: orders.shippingTrackingCode,
      publicToken: orders.publicToken,
      totalCents: orders.totalCents,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.orderNumber))
    .limit(1);

  if (!order) {
    return {
      ok: false,
      text:
        input.numero_do_pedido !== undefined
          ? `Não encontrei o pedido #${input.numero_do_pedido} neste número de WhatsApp.`
          : "Ainda não encontrei pedidos para este número de WhatsApp.",
    };
  }

  const lines = [
    `Pedido #${order.orderNumber}: ${ORDER_STATUS_LABELS[order.status] ?? order.status} — ${formatCentsBRL(order.totalCents)}`,
    ...(order.trackingCode ? [`Rastreio: ${order.trackingCode}`] : []),
    `Acompanhe: ${orderPublicUrl(order.publicToken)}`,
  ];
  return { ok: true, text: lines.join("\n") };
}

/**
 * Plano B de pagamento: envia a chave Pix da loja para o cliente pagar por
 * transferência manual. Guardas: chave cadastrada (store_pix_key) E pedido
 * pending_payment do cliente DESTA conversa. Marca payment_method
 * 'pix_manual', estende o prazo para now+24h quando o atual é menor (e
 * não-nulo — cash sem prazo continua sem prazo) e avisa o dono via outbox
 * com dedupe por pedido+inbound (retry do turno nunca duplica o aviso).
 */
async function execEnviarChavePix(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["enviar_chave_pix"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  const map = await getSettingsMap(db, ["store_pix_key"]);
  const pixKey =
    typeof map["store_pix_key"] === "string" ? map["store_pix_key"].trim() : "";
  if (pixKey === "") {
    return {
      ok: false,
      text: "O Pix manual NÃO está disponível (a loja não tem chave Pix cadastrada). Não prometa Pix manual: siga pelo link de pagamento ou transfira para a equipe.",
    };
  }

  const customerId = await resolveConversationCustomerId(db, ctx);
  if (!customerId) {
    return {
      ok: false,
      text: "Ainda não encontrei pedidos para este número de WhatsApp — o Pix manual vale para um pedido já criado e aguardando pagamento.",
    };
  }

  const conditions = [
    eq(orders.customerId, customerId),
    eq(orders.status, "pending_payment"),
  ];
  if (input.numero_do_pedido !== undefined) {
    conditions.push(eq(orders.orderNumber, input.numero_do_pedido));
  }
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      paymentDueAt: orders.paymentDueAt,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.orderNumber))
    .limit(1);
  if (!order) {
    return {
      ok: false,
      text:
        input.numero_do_pedido !== undefined
          ? `Não encontrei o pedido #${input.numero_do_pedido} aguardando pagamento neste número de WhatsApp.`
          : "Não encontrei pedido aguardando pagamento neste número de WhatsApp. Crie o pedido antes de oferecer o Pix manual.",
    };
  }

  const now = new Date();
  const extendedDueAt = new Date(
    now.getTime() + PIX_MANUAL_TTL_HOURS * 60 * 60_000,
  );
  const shouldExtendDue =
    order.paymentDueAt !== null &&
    order.paymentDueAt.getTime() < extendedDueAt.getTime();
  const effectiveDueAt = shouldExtendDue ? extendedDueAt : order.paymentDueAt;

  const updateSet: Partial<typeof orders.$inferInsert> = { updatedAt: now };
  if (order.paymentMethod !== "pix_manual") {
    updateSet.paymentMethod = "pix_manual";
  }
  if (shouldExtendDue) {
    updateSet.paymentDueAt = extendedDueAt;
  }
  if (order.paymentMethod !== "pix_manual" || shouldExtendDue) {
    await db.update(orders).set(updateSet).where(eq(orders.id, order.id));
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "order.pix_manual",
      entityType: "order",
      entityId: order.id,
      before: {
        paymentMethod: order.paymentMethod,
        paymentDueAt: order.paymentDueAt?.toISOString() ?? null,
      },
      after: {
        paymentMethod: "pix_manual",
        paymentDueAt: effectiveDueAt?.toISOString() ?? null,
      },
      reason: "Chave Pix enviada pela vendedora (plano B do link de pagamento)",
    });
  }

  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.pix_key:${order.id}:${ctx.lastInboundId}`,
    aggregateType: "order",
    aggregateId: order.id,
    payload: {
      phoneE164: ctx.phoneE164,
      body: `Pedido #${order.orderNumber}: cliente vai pagar ${formatCentsBRL(order.totalCents)} por Pix manual — confira no banco e marque como pago.`,
      raw: true,
    },
  });

  const lines = [
    `Para pagar o pedido #${order.orderNumber} por Pix:`,
    `Chave Pix: ${pixKey}`,
    `Valor EXATO: ${formatCentsBRL(order.totalCents)}`,
    "Quando fizer o Pix, avise aqui na conversa — o dono confere e confirma o pagamento.",
    ...(effectiveDueAt !== null
      ? [
          `Sua reserva vale até ${formatDateTimeSP(effectiveDueAt)} (horário de Brasília).`,
        ]
      : []),
  ];
  return { ok: true, text: lines.join("\n") };
}

/**
 * Aviso interno ao dono (ex.: "cliente diz que já fez o Pix"). Sai via outbox
 * (nunca inline) com dedupe pela última inbound — retry do turno não duplica.
 */
async function execAvisarDono(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["avisar_dono"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.avisar_dono:${ctx.lastInboundId}`,
    aggregateType: "wa_conversation",
    aggregateId: ctx.conversationId,
    payload: {
      phoneE164: ctx.phoneE164,
      body: `📢 Aviso da vendedora: ${input.mensagem}`,
      raw: true,
    },
  });
  return {
    ok: true,
    text: "Aviso enviado ao dono da loja. Diga ao cliente que o dono confere e confirma — NUNCA afirme que o pagamento já foi confirmado.",
  };
}

async function execAnotar(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["anotar"],
): Promise<ToolResult> {
  // Guarda de privacidade: nada que pareça CPF, cartão ou CEP vai para o
  // caderninho, por mais que o modelo insista.
  if (/\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{4}\s?\d{4}\s?\d{4}\s?\d{4}|\d{5}-?\d{3}/.test(input.nota)) {
    return {
      ok: false,
      text: "Não anoto documentos, cartões nem endereços — só preferências (tamanho, cores, ocasião, para quem compra).",
    };
  }
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    notes: addNote(current.notes, input.nota),
  }));
  return {
    ok: true,
    text: `Anotado. Caderninho: ${(state.notes ?? []).join("; ")}`,
  };
}

async function execTransferir(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["transferir_para_atendente"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  await handOffToHuman(
    db,
    {
      conversationId: ctx.conversationId,
      phoneE164: ctx.phoneE164,
      lastInboundId: ctx.lastInboundId,
    },
    input.motivo,
    input.resumo?.trim() || undefined,
  );
  return { ok: true, text: "transferido", endsTurn: true };
}

// ---------------------------------------------------------------------------
// buildToolExecutor
// ---------------------------------------------------------------------------

export function buildToolExecutor(
  db: DbOrTx,
  ctx: BotExecutorContext,
): ToolExecutor {
  return async (name, rawInput) => {
    const schema = BOT_TOOL_INPUT_SCHEMAS[name];
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      const detalhes = parsed.error.issues
        .map((issue) => issue.message)
        .join("; ");
      return { ok: false, text: `Dados inválidos: ${detalhes}` };
    }

    switch (name) {
      case "listar_produtos":
        return execListarProdutos(
          db,
          ctx,
          parsed.data as BotToolInputs["listar_produtos"],
        );
      case "detalhar_produto":
        return execDetalharProduto(
          db,
          ctx,
          parsed.data as BotToolInputs["detalhar_produto"],
        );
      case "adicionar_a_sacola":
        return execAdicionarASacola(
          db,
          ctx,
          parsed.data as BotToolInputs["adicionar_a_sacola"],
        );
      case "ver_sacola":
        return execVerSacola(db, ctx);
      case "remover_da_sacola":
        return execRemoverDaSacola(
          db,
          ctx,
          parsed.data as BotToolInputs["remover_da_sacola"],
        );
      case "cotar_frete":
        return execCotarFrete(db, ctx, parsed.data as BotToolInputs["cotar_frete"]);
      case "buscar_cadastro":
        return execBuscarCadastro(db, ctx);
      case "criar_pedido":
        return execCriarPedido(db, ctx, parsed.data as BotToolInputs["criar_pedido"]);
      case "status_do_pedido":
        return execStatusDoPedido(
          db,
          ctx,
          parsed.data as BotToolInputs["status_do_pedido"],
        );
      case "enviar_chave_pix":
        return execEnviarChavePix(
          db,
          ctx,
          parsed.data as BotToolInputs["enviar_chave_pix"],
        );
      case "avisar_dono":
        return execAvisarDono(
          db,
          ctx,
          parsed.data as BotToolInputs["avisar_dono"],
        );
      case "anotar":
        return execAnotar(db, ctx, parsed.data as BotToolInputs["anotar"]);
      case "transferir_para_atendente":
        return execTransferir(
          db,
          ctx,
          parsed.data as BotToolInputs["transferir_para_atendente"],
        );
    }
  };
}

// ---------------------------------------------------------------------------
// Prompt do turno: configurações + planta da loja. Compartilhado com o
// ensaio do painel ("Testar a vendedora").
// ---------------------------------------------------------------------------

export type BotPromptBundle = {
  system: string;
  model: string;
  sellerName: string;
};

export async function buildBotPromptBundle(db: DbOrTx): Promise<BotPromptBundle> {
  const map = await getSettingsMap(db, [
    "store_name",
    "bot_extra_instructions",
    "bot_model",
    "bot_seller_name",
    "store_exchange_policy",
  ]);
  const text = (key: string): string =>
    typeof map[key] === "string" ? (map[key] as string).trim() : "";
  const storeName = text("store_name") || DEFAULT_STORE_NAME;
  const model = text("bot_model") || DEFAULT_BOT_MODEL;
  const sellerName = text("bot_seller_name") || DEFAULT_SELLER_NAME;

  const storeMap = renderStoreMap(await getStoreMap(db));

  const system = buildBotSystemPrompt({
    storeName,
    sellerName,
    extraInstructions: text("bot_extra_instructions"),
    siteUrl: siteBaseUrl(),
    ...(storeMap ? { storeMap } : {}),
    exchangePolicy: text("store_exchange_policy"),
  });
  return { system, model, sellerName };
}

/** Histórico + caderninho como o modelo recebe (primeira mensagem = contexto). */
export function assembleHistory(
  state: BotState,
  messages: BotChatMessage[],
): BotChatMessage[] {
  const note = renderContextNote(state);
  return note ? [{ role: "user", text: note }, ...messages] : messages;
}

// ---------------------------------------------------------------------------
// runBotTurn — um turno completo sobre a conversa, chamado pelo handler
// 'wa.bot_turn' da fila. FOR UPDATE serializa turnos concorrentes da mesma
// conversa; a idempotência REAL da resposta vem do dedupe derivado do id da
// última wa_message inbound (retry da fila nunca duplica resposta).
// ---------------------------------------------------------------------------

export async function runBotTurn(
  db: DbOrTx,
  assistant: SalesAssistant,
  provider: MessagingProvider,
  input: { conversationId: string },
): Promise<RunBotTurnResult> {
  const { conversationId } = input;

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, conversationId))
      .for("update");

    if (!conversation) return { skipped: "conversa_inexistente" };
    if (conversation.status === "human") return { skipped: "atendimento_humano" };
    if (conversation.status === "closed") return { skipped: "conversa_fechada" };
    if (
      conversation.botDisabledUntil !== null &&
      conversation.botDisabledUntil.getTime() > Date.now()
    ) {
      return { skipped: "bot_silenciado" };
    }
    if (!(await isBotEnabled(tx))) return { skipped: "desabilitado" };

    const [lastInbound] = await tx
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.conversationId, conversationId),
          eq(waMessages.direction, "inbound"),
        ),
      )
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(1);
    if (!lastInbound) return { skipped: "sem_mensagem_inbound" };

    // Histórico: últimas mensagens em ordem cronológica, com a origem de cada
    // saída marcada (equipe/automático) e mídia resumida em marcadores.
    const recent = await tx
      .select({
        direction: waMessages.direction,
        body: waMessages.body,
        kind: waMessages.kind,
        dedupeKey: waMessages.dedupeKey,
        templateKey: waMessages.templateKey,
      })
      .from(waMessages)
      .where(eq(waMessages.conversationId, conversationId))
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(HISTORY_LIMIT);
    const messages: BotChatMessage[] = recent.reverse().map((message) =>
      message.direction === "inbound"
        ? { role: "user" as const, text: message.body }
        : {
            role: "assistant" as const,
            text: historyTextForOutbound(message),
          },
    );
    const state = parseBotState(conversation.botState);
    const history = assembleHistory(state, messages);

    const { system, model } = await buildBotPromptBundle(tx);

    // Mídia emitida pelas ferramentas do turno (lista tocável, foto).
    const attachments: BotAttachment[] = [];
    const executeTool = buildToolExecutor(tx, {
      conversationId,
      phoneE164: conversation.phoneE164,
      customerId: conversation.customerId,
      lastInboundId: lastInbound.id,
      onAttachment: (attachment) => attachments.push(attachment),
    });

    const replyDedupeKey = `wa.bot_reply:${lastInbound.id}`;
    const customerRef = conversation.customerId
      ? { customerId: conversation.customerId }
      : {};

    let turn: AssistantTurn;
    const startedAt = Date.now();
    try {
      turn = await assistant.respondTurn({ system, history, model, executeTool });
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        // Plano B: avisa o cliente, transfere para humano (audit + aviso ao
        // dono) e encerra o turno sem propagar — o evento da fila conclui.
        await sendTemplateMessage(tx, provider, {
          bodyOverride: BOT_UNAVAILABLE_REPLY,
          phoneE164: conversation.phoneE164,
          ...customerRef,
          dedupeKey: replyDedupeKey,
          requireOptIn: false,
        });
        await handOffToHuman(
          tx,
          {
            conversationId,
            phoneE164: conversation.phoneE164,
            lastInboundId: lastInbound.id,
          },
          "Assistente de IA indisponível",
        );
        return { replied: true, handedOff: true };
      }
      throw error;
    }

    // Mídia ANTES do texto (o cliente vê a lista/foto e depois o convite),
    // cada uma com dedupe determinístico por índice; falha é melhor esforço.
    for (const [index, attachment] of attachments.entries()) {
      const mediaDedupeKey = `wa.bot_media:${lastInbound.id}:${index}`;
      try {
        if (attachment.kind === "option_list") {
          await sendMediaMessage(tx, provider, {
            kind: "option_list",
            body: attachment.message,
            optionList: {
              title: attachment.title,
              buttonLabel: attachment.buttonLabel,
              options: attachment.options,
            },
            phoneE164: conversation.phoneE164,
            ...customerRef,
            dedupeKey: mediaDedupeKey,
            requireOptIn: false,
          });
        } else {
          await sendMediaMessage(tx, provider, {
            kind: "image",
            imageUrl: attachment.imageUrl,
            body: attachment.caption,
            phoneE164: conversation.phoneE164,
            ...customerRef,
            dedupeKey: mediaDedupeKey,
            requireOptIn: false,
          });
        }
      } catch (error) {
        console.warn(
          `[wa-bot] Falha ao enviar mídia ${mediaDedupeKey}; o texto da IA segue mesmo assim.`,
          error,
        );
      }
    }

    // Resposta em até 3 balões (o modelo separa com '---'), o primeiro com o
    // dedupe histórico e os demais com sufixo — retry nunca duplica nenhum.
    const bubbles = turn.reply === null ? [] : splitBotReply(turn.reply);

    // Trilha do turno para o painel e para o custo por conversa: quais
    // ferramentas rodaram, tokens gastos, tempo e se transferiu. Nunca guarda
    // o texto (ele já está em wa_messages).
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.bot_turn",
      entityType: "wa_conversation",
      entityId: conversationId,
      after: {
        inboundId: lastInbound.id,
        model,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        handedOff: turn.handedOff,
        attachments: attachments.map((attachment) => attachment.kind),
        bubbles: bubbles.length,
        durationMs: Date.now() - startedAt,
      },
    });

    let replied = false;
    for (const [index, bubble] of bubbles.entries()) {
      const sent = await sendTemplateMessage(tx, provider, {
        bodyOverride: truncateForWhatsApp(bubble),
        phoneE164: conversation.phoneE164,
        ...customerRef,
        dedupeKey: index === 0 ? replyDedupeKey : `${replyDedupeKey}:${index}`,
        requireOptIn: false,
      });
      if ("sent" in sent) replied = true;
    }

    if (turn.handedOff) {
      // Cortesia pós-transferência, com dedupe próprio (também idempotente).
      await sendTemplateMessage(tx, provider, {
        bodyOverride: HANDOFF_COURTESY_REPLY,
        phoneE164: conversation.phoneE164,
        ...customerRef,
        dedupeKey: `wa.bot_handoff_notice:${lastInbound.id}`,
        requireOptIn: false,
      });
    }

    return { replied, handedOff: turn.handedOff };
  });
}
