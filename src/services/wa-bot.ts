// BOT DE VENDAS IA no WhatsApp (Fase 5, Onda B): executa UM turno de conversa
// por evento 'wa.bot_turn' da fila. A IA nunca é fonte de fatos — preço,
// estoque, frete e pedido saem das ferramentas deste arquivo, que devolvem
// blocos pt-BR prontos. Regras duras: resposta idempotente por mensagem
// inbound (dedupe em wa_messages), transferência para humano SEMPRE audita e
// silencia o bot por 24h, e nada aqui toca o fluxo SAIR/opt-out (wa-inbound).
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
  BOT_TOOL_INPUT_SCHEMAS,
  type BotToolInputs,
  type ToolExecutor,
} from "@/core/bot/tools";
import { buildBotSystemPrompt, truncateForWhatsApp } from "@/core/bot/prompt";
import {
  auditLog,
  customers,
  orders,
  priceVersions,
  products,
  productVariants,
  waConversations,
  waMessages,
} from "@/db/schema";
import { formatDateTimeSP } from "@/emails/templates";
import { isValidCpf } from "@/lib/document";
import { formatCentsBRL } from "@/lib/money";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import {
  computeTotalWeightGrams,
  DEFAULT_ITEM_WEIGHT_GRAMS,
  getPublicProductBySlug,
  listPublicProducts,
  publicImageUrl,
  quoteShipping,
  type PublicProductDetail,
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
const DEFAULT_STORE_NAME = "TRIVË";
const HISTORY_LIMIT = 20;
const MAX_LISTED_PRODUCTS = 8;
const HANDOFF_SILENCE_HOURS = 24;

export const BOT_UNAVAILABLE_REPLY =
  "Nosso atendimento automático está indisponível — já chamei um atendente 😉";
export const HANDOFF_COURTESY_REPLY =
  "Um atendente humano vai te responder por aqui em breve! 🙋";

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

/** Contexto compacto persistido em wa_conversations.bot_state (jsonb). */
type BotState = {
  cart?: { sku: string; quantidade: number }[];
  lastQuotes?: ShippingQuote[];
};

/**
 * Mídia que uma ferramenta quer enviar ao cliente NESTE turno (menu interativo
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
  onAttachment?: (attachment: BotAttachment) => void;
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
// Helpers de estado da conversa
// ---------------------------------------------------------------------------

async function loadBotState(db: DbOrTx, conversationId: string): Promise<BotState> {
  const [row] = await db
    .select({ botState: waConversations.botState })
    .from(waConversations)
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  const state = row?.botState;
  return state && typeof state === "object" ? (state as BotState) : {};
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

/**
 * Transfere a conversa para atendimento humano: status 'human', bot em
 * silêncio por 24h, audit e aviso ao dono via outbox. Compartilhado entre a
 * ferramenta transferir_para_atendente e o fallback de IA indisponível.
 */
async function handOffToHuman(
  db: DbOrTx,
  ctx: { conversationId: string; phoneE164: string },
  motivo: string,
): Promise<void> {
  const now = new Date();
  const botDisabledUntil = new Date(
    now.getTime() + HANDOFF_SILENCE_HOURS * 60 * 60_000,
  );

  await db
    .update(waConversations)
    .set({ status: "human", botDisabledUntil, updatedAt: now })
    .where(eq(waConversations.id, ctx.conversationId));

  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.bot_handoff",
    entityType: "wa_conversation",
    entityId: ctx.conversationId,
    after: { motivo, botDisabledUntil: botDisabledUntil.toISOString() },
    reason: motivo,
  });

  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.handoff:${ctx.conversationId}:${Date.now()}`,
    aggregateType: "wa_conversation",
    aggregateId: ctx.conversationId,
    payload: {
      phoneE164: ctx.phoneE164,
      body: `🤖→👤 O robô transferiu a conversa com ${ctx.phoneE164}: ${motivo}. Responda pelo painel ou aqui mesmo.`,
      raw: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Executores das ferramentas
// ---------------------------------------------------------------------------

type ToolResult = { ok: boolean; text: string; endsTurn?: boolean };

function formatDeliveryDays(min: number, max: number): string {
  return min === max ? `${min} dias úteis` : `${min} a ${max} dias úteis`;
}

// Limites da lista interativa da Z-API: até 10 opções, título com 24 chars.
const OPTION_LIST_MAX_OPTIONS = 10;
const OPTION_TITLE_MAX_CHARS = 24;

function truncateOptionTitle(name: string): string {
  return name.length <= OPTION_TITLE_MAX_CHARS
    ? name
    : `${name.slice(0, OPTION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

function formatPriceRange(fromCents: number, toCents: number): string {
  return fromCents === toCents
    ? formatCentsBRL(fromCents)
    : `a partir de ${formatCentsBRL(fromCents)}`;
}

async function execListarProdutos(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["listar_produtos"],
): Promise<ToolResult> {
  const busca = input.busca?.trim();
  const items = await listPublicProducts(db, busca ? { q: busca } : {});

  if (items.length === 0) {
    return {
      ok: true,
      text: busca
        ? `Não encontrei produtos para "${busca}". Posso mostrar o catálogo completo?`
        : "O catálogo está vazio no momento — em breve teremos novidades!",
    };
  }

  const lines = items.slice(0, MAX_LISTED_PRODUCTS).map((item) => {
    const preco = formatPriceRange(item.priceFromCents, item.priceToCents);
    return `• ${item.name} — ${preco}${item.available ? "" : " (esgotado)"}`;
  });
  if (items.length > MAX_LISTED_PRODUCTS) {
    lines.push(`e mais ${items.length - MAX_LISTED_PRODUCTS} no site ${siteBaseUrl()}`);
  }

  if (ctx.onAttachment) {
    const map = await getSettingsMap(db, ["store_name"]);
    const title =
      typeof map["store_name"] === "string" && map["store_name"].trim() !== ""
        ? map["store_name"].trim()
        : "Nossos produtos";
    ctx.onAttachment({
      kind: "option_list",
      message: "Toque abaixo para ver os produtos 👇",
      title,
      buttonLabel: "Ver produtos",
      options: items.slice(0, OPTION_LIST_MAX_OPTIONS).map((item) => ({
        id: `produto:${item.slug}`,
        title: truncateOptionTitle(item.name),
        description: formatPriceRange(item.priceFromCents, item.priceToCents),
      })),
    });
    lines.push(
      "[Um menu interativo com os produtos foi enviado ao cliente. Responda em 1 frase curta convidando a tocar em Ver produtos — NÃO repita a lista de preços.]",
    );
  }
  return { ok: true, text: lines.join("\n") };
}

/** Resolve por slug exato, depois SKU exato (case-insensitive), depois nome aproximado. */
async function resolveProductDetail(
  db: DbOrTx,
  term: string,
): Promise<PublicProductDetail | null> {
  const trimmed = term.trim();
  if (trimmed === "") return null;

  const bySlug = await getPublicProductBySlug(db, trimmed.toLowerCase());
  if (bySlug) return bySlug;

  const [bySku] = await db
    .select({ slug: products.slug })
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
    if (detail) return detail;
  }

  const list = await listPublicProducts(db, {});
  const lowered = trimmed.toLowerCase();
  const match =
    list.find((p) => p.name.toLowerCase().includes(lowered)) ??
    list.find((p) => lowered.includes(p.name.toLowerCase()));
  return match ? getPublicProductBySlug(db, match.slug) : null;
}

async function execDetalharProduto(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["detalhar_produto"],
): Promise<ToolResult> {
  const detail = await resolveProductDetail(db, input.produto);
  if (!detail) {
    return {
      ok: false,
      text: `Não encontrei o produto "${input.produto}". Use listar_produtos para ver o catálogo disponível.`,
    };
  }

  // Foto: primeira imagem do produto (images já vem ordenado por sort_order).
  let photoEmitted = false;
  const imagePath = detail.images[0];
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
      ctx.onAttachment({
        kind: "image",
        imageUrl,
        caption: `${detail.name} — ${preco}`,
      });
      photoEmitted = true;
    }
  }

  const lines = [detail.name];
  const description = detail.description?.trim();
  if (description) {
    lines.push(
      description.length > 200 ? `${description.slice(0, 200).trimEnd()}…` : description,
    );
  }
  for (const variant of detail.variants) {
    const label = Object.values(variant.attributes).join(" / ");
    const disponibilidade =
      variant.availableQty > 0
        ? `${variant.availableQty} ${variant.availableQty === 1 ? "disponível" : "disponíveis"}`
        : "esgotado";
    lines.push(
      `• ${label ? `${label} — ` : ""}${formatCentsBRL(variant.priceCents)} (${disponibilidade}) — SKU: ${variant.sku}`,
    );
  }
  if (detail.variants.every((variant) => variant.availableQty === 0)) {
    lines.push("Atenção: este produto está esgotado no momento.");
  }
  if (photoEmitted) {
    lines.push("[A foto do produto foi enviada ao cliente.]");
  }
  return { ok: true, text: lines.join("\n") };
}

async function execCotarFrete(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["cotar_frete"],
): Promise<ToolResult> {
  const state = await loadBotState(db, ctx.conversationId);
  const cart = state.cart ?? [];

  // Com itens acumulados no botState, o peso é real; sem carrinho, cotamos
  // com o peso padrão de 1 item e dizemos com honestidade que é estimativa.
  let totalWeightGrams = DEFAULT_ITEM_WEIGHT_GRAMS;
  let isEstimate = true;
  if (cart.length > 0) {
    const skus = cart.map((item) => item.sku);
    const variants = await db
      .select({ sku: productVariants.sku, weightGrams: productVariants.weightGrams })
      .from(productVariants)
      .where(inArray(productVariants.sku, skus));
    const weightBySku = new Map(variants.map((v) => [v.sku, v.weightGrams]));
    totalWeightGrams = computeTotalWeightGrams(
      cart.map((item) => ({
        weightGrams: weightBySku.get(item.sku) ?? null,
        quantity: item.quantidade,
      })),
    );
    isEstimate = false;
  }

  const quotes = await quoteShipping(db, { cep: input.cep, totalWeightGrams });
  if (quotes.length === 0) {
    return {
      ok: false,
      text: "Não entregamos para este CEP no momento. Confira se o CEP está correto, por favor.",
    };
  }

  await saveBotState(db, ctx.conversationId, { ...state, lastQuotes: quotes });

  const lines = quotes.map(
    (quote, index) =>
      `${index + 1}. ${quote.name} — ${formatCentsBRL(quote.priceCents)} (${formatDeliveryDays(quote.deliveryDaysMin, quote.deliveryDaysMax)})`,
  );
  if (isEstimate) {
    lines.push("Estimativa para 1 item — o valor final aparece no resumo do pedido.");
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

async function execCriarPedido(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["criar_pedido"],
): Promise<ToolResult> {
  // CPF com dígito verificador válido — a nota fiscal depende disso.
  if (!isValidCpf(input.cpf)) {
    return {
      ok: false,
      text: "CPF inválido — confira os 11 dígitos com o cliente e tente de novo.",
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
  for (const item of input.itens) {
    const variant = await resolveVariantBySku(db, item.sku);
    if (!variant) {
      return {
        ok: false,
        text: `Não encontrei o SKU "${item.sku}" no catálogo. Confirme o produto com detalhar_produto antes de fechar o pedido.`,
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

  // Frete: recota com o peso real e escolhe a opção MAIS BARATA (simples e
  // determinístico — quoteShipping já ordena por preço).
  const totalWeightGrams = computeTotalWeightGrams(
    resolved.map((r) => ({ weightGrams: r.weightGrams, quantity: r.quantity })),
  );
  const quotes = await quoteShipping(db, { cep: input.cep, totalWeightGrams });
  const cheapest = quotes[0];
  if (!cheapest) {
    return {
      ok: false,
      text: "Não entregamos para este CEP no momento. Confira se o CEP está correto, por favor.",
    };
  }

  let created;
  try {
    created = await createStoreOrder(db, {
      channel: "whatsapp",
      customer: {
        fullName: input.nome_completo,
        document: input.cpf,
        // Telefone é SEMPRE o da conversa — nunca um número ditado ao bot.
        phone: ctx.phoneE164,
        marketingOptIn: true,
      },
      address: {
        postalCode: input.cep,
        street: input.rua,
        number: input.numero,
        ...(input.complemento !== undefined ? { complement: input.complemento } : {}),
        district: input.bairro,
        city: input.cidade,
        state: input.uf,
      },
      items: resolved.map((r) => ({
        variantId: r.variantId,
        quantity: r.quantity,
        expectedUnitPriceCents: r.unitPriceCents,
      })),
      shippingRateId: cheapest.rateId,
      expectedShippingCents: cheapest.priceCents,
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

  // Vincula o cliente do pedido à conversa (histórico e opt-in coerentes).
  const [orderRow] = await db
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.id, created.orderId))
    .limit(1);
  if (orderRow) {
    await db
      .update(waConversations)
      .set({ customerId: orderRow.customerId, updatedAt: new Date() })
      .where(eq(waConversations.id, ctx.conversationId));
  }

  // Link de pagamento: Mercado Pago quando ligado; senão a página pública do
  // pedido. Falha ao criar a preference NÃO derruba o pedido já criado.
  let paymentLine = `Acompanhe e pague: ${orderPublicUrl(created.publicToken)}`;
  if (await isMpEnabled(db)) {
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
  const discountCents = subtotalCents + cheapest.priceCents - created.totalCents;

  const lines = [
    `Pedido #${created.orderNumber} criado! 🎉`,
    ...resolved.map(
      (r) =>
        `• ${r.quantity}× ${r.name} — ${formatCentsBRL(r.unitPriceCents * r.quantity)}`,
    ),
    `Frete (${cheapest.name}): ${formatCentsBRL(cheapest.priceCents)}`,
    ...(discountCents > 0 ? [`Desconto: -${formatCentsBRL(discountCents)}`] : []),
    `TOTAL: ${formatCentsBRL(created.totalCents)}`,
    paymentLine,
    `Reserva garantida até ${formatDateTimeSP(created.paymentDueAt)} (horário de Brasília).`,
  ];
  return { ok: true, text: lines.join("\n") };
}

async function execStatusDoPedido(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["status_do_pedido"],
): Promise<ToolResult> {
  // Segurança: só pedidos do cliente DESTA conversa (vínculo ou telefone).
  let customerId = ctx.customerId;
  if (!customerId) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.phoneE164, ctx.phoneE164), isNull(customers.deletedAt)),
      )
      .limit(1);
    customerId = customer?.id ?? null;
  }
  if (!customerId) {
    return {
      ok: false,
      text: "Ainda não encontrei pedidos para este número de WhatsApp. Se o pedido foi feito com outro telefone, posso chamar um atendente.",
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

async function execTransferir(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["transferir_para_atendente"],
): Promise<ToolResult> {
  await handOffToHuman(
    db,
    { conversationId: ctx.conversationId, phoneE164: ctx.phoneE164 },
    input.motivo,
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
      case "cotar_frete":
        return execCotarFrete(db, ctx, parsed.data as BotToolInputs["cotar_frete"]);
      case "criar_pedido":
        return execCriarPedido(db, ctx, parsed.data as BotToolInputs["criar_pedido"]);
      case "status_do_pedido":
        return execStatusDoPedido(
          db,
          ctx,
          parsed.data as BotToolInputs["status_do_pedido"],
        );
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

    // Histórico: últimas 20 mensagens em ordem cronológica.
    const recent = await tx
      .select({ direction: waMessages.direction, body: waMessages.body })
      .from(waMessages)
      .where(eq(waMessages.conversationId, conversationId))
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(HISTORY_LIMIT);
    const history: BotChatMessage[] = recent
      .reverse()
      .map((message) => ({
        role: message.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        text: message.body,
      }));

    const map = await getSettingsMap(tx, [
      "store_name",
      "bot_extra_instructions",
      "bot_model",
    ]);
    const storeName =
      typeof map["store_name"] === "string" && map["store_name"].trim() !== ""
        ? map["store_name"].trim()
        : DEFAULT_STORE_NAME;
    const extraInstructions =
      typeof map["bot_extra_instructions"] === "string"
        ? map["bot_extra_instructions"]
        : "";
    const model =
      typeof map["bot_model"] === "string" && map["bot_model"].trim() !== ""
        ? map["bot_model"]
        : DEFAULT_BOT_MODEL;

    const system = buildBotSystemPrompt({
      storeName,
      extraInstructions,
      siteUrl: siteBaseUrl(),
    });

    // Mídia emitida pelas ferramentas do turno (menu de produtos, foto).
    const attachments: BotAttachment[] = [];
    const executeTool = buildToolExecutor(tx, {
      conversationId,
      phoneE164: conversation.phoneE164,
      customerId: conversation.customerId,
      onAttachment: (attachment) => attachments.push(attachment),
    });

    const replyDedupeKey = `wa.bot_reply:${lastInbound.id}`;
    const customerRef = conversation.customerId
      ? { customerId: conversation.customerId }
      : {};

    let turn: AssistantTurn;
    try {
      turn = await assistant.respondTurn({ system, history, model, executeTool });
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        // IA fora do ar: resposta fixa gentil + transferência para humano
        // (mesma lógica da ferramenta, com audit e aviso ao dono).
        const sent = await sendTemplateMessage(tx, provider, {
          bodyOverride: BOT_UNAVAILABLE_REPLY,
          phoneE164: conversation.phoneE164,
          ...customerRef,
          dedupeKey: replyDedupeKey,
          requireOptIn: false,
        });
        await handOffToHuman(
          tx,
          { conversationId, phoneE164: conversation.phoneE164 },
          "Assistente de IA indisponível",
        );
        return { replied: "sent" in sent, handedOff: true };
      }
      throw error;
    }

    // Mídia sai ANTES do texto, em MELHOR ESFORÇO: falha de envio nunca segura
    // a resposta da IA. O dedupe determinístico (última inbound + índice)
    // garante que o retry do evento não duplica menu nem foto.
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

    let replied = false;
    if (turn.reply !== null && turn.reply.trim() !== "") {
      const sent = await sendTemplateMessage(tx, provider, {
        bodyOverride: truncateForWhatsApp(turn.reply),
        phoneE164: conversation.phoneE164,
        ...customerRef,
        dedupeKey: replyDedupeKey,
        requireOptIn: false,
      });
      replied = "sent" in sent;
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
