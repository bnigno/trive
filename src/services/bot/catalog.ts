// Ferramentas de catálogo da vendedora: listar, detalhar, montar look e resolver peças/variações.
import { and, eq, gt, ilike, inArray, isNull, sql } from "drizzle-orm";
import { CATALOG_MAX_LISTS_PER_CALL, CATALOG_RESEND_GUARD_MS, catalogListMessage, truncateOptionTitle } from "@/core/bot/option-list";
import type { BotToolInputs } from "@/core/bot/tools";
import {
  buildVariantMenu,
  colorOfVariant,
  formatVariantLines,
  pickImagePath,
} from "@/core/bot/variants";
import { pickLookComplements } from "@/core/bot/look";
import { getStyleProfileByPhone } from "@/services/style-profiles";
import {
  CARD_MAX_ITEMS,
  catalogCardEyebrow,
  catalogCardTitle,
  LOOK_EYEBROW,
  LOOK_MAX_COMPLEMENTS,
  lookCardTitle,
} from "@/core/cards/types";
import { variantLabel } from "@/core/catalog/attributes";
import { curatorNoteLines } from "@/core/bot/curator-note";
import { careNotesToLabels, parseCareNotes } from "@/core/catalog/care";
import {
  buildSizeChart,
  isSizeChartEmpty,
  renderSizeChartLines,
} from "@/core/catalog/measurements";
import {
  categories,
  priceVersions,
  products,
  productVariants,
  stockLevels,
  waMessages,
} from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveCityEditionSlug } from "@/services/city-editions";
import { isBotAudioNotesEnabled } from "@/services/curator-notes";
import { getSettingsMap } from "@/services/settings";
import {
  getPublicProductBySlug,
  listProductIdsWithVariant,
  listPublicProducts,
  listPublicVariantFacts,
  publicImageUrl,
  type PublicProductDetail,
  type PublicProductListItem,
} from "@/services/store-catalog";
import { siteBaseUrl } from "@/services/wa-messaging";

import { DESCRIPTION_MAX_CHARS, PAGE_SIZE, formatPriceRange, readBotState, updateBotState } from "./shared";
import type { BotExecutorContext, ExecutorCtx, ToolResult } from "./shared";

/** Categoria por slug exato ou nome aproximado; null quando não existe. */
export async function resolveCategorySlug(
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

type CatalogList = { message: string; options: { title: string; description?: string }[] };

/** O corpo que sendMediaMessage persiste para uma lista: a mensagem + uma linha por opção. */
function persistedListBody(list: CatalogList): string {
  return [list.message, ...list.options.map((option) => (option.description ? `• ${option.title} — ${option.description}` : `• ${option.title}`))].join("\n");
}

/** As listas (2..N) deste catálogo saíram de verdade nesta conversa dentro da janela? */
async function catalogListsDelivered(db: DbOrTx, conversationId: string, lists: readonly CatalogList[], now: Date): Promise<boolean> {
  const bodies = lists.map(persistedListBody);
  const rows = await db
    .select({ body: waMessages.body })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.conversationId, conversationId),
        eq(waMessages.direction, "outbound"),
        eq(waMessages.kind, "option_list"),
        eq(waMessages.status, "sent"),
        gt(waMessages.createdAt, new Date(now.getTime() - CATALOG_RESEND_GUARD_MS)),
        inArray(waMessages.body, bodies),
      ),
    );
  const delivered = new Set(rows.map((row) => row.body));
  return bodies.every((body) => delivered.has(body));
}

/**
 * SKU por igualdade, sem maiúsculas — nunca ILIKE: "_" e "%" viravam curinga
 * e um "%" solto devolvia a primeira variante da tabela. Bate no índice
 * product_variants_sku_lower_unique_idx.
 */
function skuEquals(sku: string) {
  return sql`lower(${productVariants.sku}) = lower(${sku.trim()})`;
}

/** O título da lista tocável: o nome da loja. */
async function storeTitle(db: DbOrTx): Promise<string> {
  const map = await getSettingsMap(db, ["store_name"]);
  return typeof map["store_name"] === "string" && map["store_name"].trim() !== "" ? map["store_name"].trim() : "Nossas peças";
}

export async function execListarProdutos(
  db: DbOrTx,
  ctx: ExecutorCtx,
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
  let editionSlug: string | undefined;
  if (input.edicao?.trim()) {
    const edition = await resolveCityEditionSlug(db, input.edicao);
    if (!edition) {
      return {
        ok: false,
        text: `Não existe a edição "${input.edicao}". Use uma das Edições de Belém da PLANTA DA LOJA ou busque sem o filtro edicao — e nunca invente uma edição para a cliente.`,
      };
    }
    editionSlug = edition.slug;
    // "Edição Círio" já traz a palavra; "Círio" ganha o prefixo.
    filtros.push(/^edi[cç][aã]o\b/i.test(edition.name) ? edition.name : `edição ${edition.name}`);
  }
  if (busca) filtros.push(`"${busca}"`);

  let items: PublicProductListItem[] = await listPublicProducts(db, {
    ...(busca ? { q: busca, includeDescription: true } : {}),
    ...(categorySlug ? { categorySlug } : {}),
    ...(editionSlug ? { editionSlug } : {}),
    viewer: { customerId: ctx.customerId },
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

  const totalPaginas = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pagina = Math.min(input.pagina ?? 1, totalPaginas);
  const linhaDaPeca = (item: PublicProductListItem) => {
    const preco = formatPriceRange(item.priceFromCents, item.priceToCents);
    const categoria = item.categoryName ? ` · ${item.categoryName}` : "";
    return `• ${item.name}${categoria} — ${preco}${item.available ? "" : " (esgotado)"}`;
  };
  const listaTocavel = (fatia: PublicProductListItem[], inicio: number, title: string) => ({
    kind: "option_list" as const,
    message: catalogListMessage(inicio + 1, inicio + fatia.length, items.length),
    title,
    buttonLabel: "Ver o catálogo",
    options: fatia.map((item) => ({
      id: `produto:${item.slug}`,
      title: truncateOptionTitle(item.name),
      description: formatPriceRange(item.priceFromCents, item.priceToCents),
    })),
  });
  const contagem = `${items.length} ${items.length === 1 ? "peça encontrada" : "peças encontradas"}${descricaoFiltro}`;

  // Página explícita (a Lia pediu "as próximas"): uma lista só, como sempre.
  if ((input.pagina ?? 1) > 1) {
    if ((input.pagina ?? 1) > totalPaginas) {
      return {
        ok: false,
        text: `Não existe a página ${input.pagina}: ${contagem} ${totalPaginas === 1 ? "cabe numa lista só" : `cabem em ${totalPaginas} páginas`} — e ${totalPaginas === 1 ? "ela" : "as listas"} já ${totalPaginas === 1 ? "foi enviada" : "foram enviadas"}. Não reenvie; responda à cliente com o que já está na conversa.`,
      };
    }
    const inicio = (pagina - 1) * PAGE_SIZE;
    const page = items.slice(inicio, inicio + PAGE_SIZE);
    const lines = page.map(linhaDaPeca);
    lines.unshift(
      `${contagem} — mostrando ${inicio + 1} a ${inicio + page.length} (página ${pagina} de ${totalPaginas}${pagina < totalPaginas ? `; passe pagina: ${pagina + 1} para as próximas` : "; é a última"}).`,
    );
    if (ctx.onAttachment) {
      ctx.onAttachment(listaTocavel(page, inicio, await storeTitle(db)));
      ctx.turnLists.count += 1;
      lines.push(
        "[A lista tocável do catálogo foi enviada ao cliente. Responda em 1 ou 2 frases curtas: comente até 3 peças com um motivo real cada e convide a tocar em «Ver o catálogo» — NÃO repita a lista de preços e NUNCA chame isso de menu ou cardápio: é o catálogo.]",
      );
    }
    return { ok: true, text: lines.join("\n") };
  }

  // Catálogo inteiro: até CATALOG_MAX_LISTS_PER_CALL listas de PAGE_SIZE de
  // uma vez (a lista do WhatsApp só aceita 10 linhas). Guarda contra spam —
  // a regra 11 manda chamar a ferramenta a cada "quero ver outra": se as
  // listas 2..N deste mesmo catálogo SAÍRAM (wa_messages 'sent') nos últimos
  // 30 min, vai só a primeira de novo. Ler o que foi entregue, e não um
  // estado gravado antes da entrega, cobre lista que falhou na Z-API,
  // copiloto (a sugestão aprovada também vira wa_message) e ensaio.
  const fatias: PublicProductListItem[][] = [];
  for (let inicio = 0; inicio < items.length && fatias.length < CATALOG_MAX_LISTS_PER_CALL; inicio += PAGE_SIZE) {
    fatias.push(items.slice(inicio, inicio + PAGE_SIZE));
  }
  const restantes = items.length - fatias.flat().length;
  const title = ctx.onAttachment ? await storeTitle(db) : "";
  const listas = fatias.map((fatia, index) => listaTocavel(fatia, index * PAGE_SIZE, title));
  const now = ctx.now ?? new Date();
  const recente = ctx.onAttachment && listas.length > 1 ? await catalogListsDelivered(db, ctx.conversationId, listas.slice(1), now) : false;
  // Teto do TURNO: uma segunda busca no mesmo turno (outra categoria) ainda
  // leva a sua primeira lista, mas o total de listas não passa do teto.
  const orcamento = Math.max(1, CATALOG_MAX_LISTS_PER_CALL - ctx.turnLists.count);
  const paraEnviar = recente ? listas.slice(0, 1) : listas.slice(0, orcamento);
  const cortadasPeloTurno = !recente && paraEnviar.length < listas.length;

  const lines = (recente ? fatias[0] : fatias.slice(0, paraEnviar.length).flat()).map(linhaDaPeca);
  if (recente) {
    const outras = listas.length === 2 ? "a lista 2 já está" : `as listas 2 a ${listas.length} já estão`;
    lines.unshift(`${contagem} — a 1ª lista reenviada; ${outras} na conversa (enviadas há pouco).`);
  } else if (fatias.length > 1) {
    const enviadas = paraEnviar.length * PAGE_SIZE;
    lines.unshift(
      paraEnviar.length === fatias.length && restantes === 0
        ? `${contagem} — todas enviadas em ${fatias.length} listas tocáveis.`
        : `${contagem} — as ${Math.min(enviadas, items.length)} primeiras enviadas em ${paraEnviar.length} ${paraEnviar.length === 1 ? "lista tocável" : "listas tocáveis"}.`,
    );
  } else {
    lines.unshift(`${contagem}.`);
  }

  if (ctx.onAttachment) {
    for (const lista of paraEnviar) {
      ctx.onAttachment(lista);
      ctx.turnLists.count += 1;
    }
    if (recente) {
      lines.push(
        `[A lista tocável do catálogo foi enviada ao cliente de novo — só a primeira: as outras ${listas.length - 1} listas deste mesmo catálogo foram enviadas há pouco e continuam na conversa (ela pode rolar para cima). Responda em 1 ou 2 frases curtas comentando até 3 peças e convide a tocar em «Ver o catálogo»; diga que o resto do catálogo está logo acima. Só chame pagina: 2 a ${listas.length} se ela disser que não acha as listas. NÃO repita a lista de preços e NUNCA chame isso de menu ou cardápio: é o catálogo.]`,
      );
    } else if (paraEnviar.length > 1) {
      lines.push(
        `[A lista tocável do catálogo foi enviada ao cliente em ${paraEnviar.length} listas${restantes === 0 && !cortadasPeloTurno ? " — o catálogo completo" : ""}. Responda em 1 ou 2 frases curtas: ${restantes === 0 && !cortadasPeloTurno ? "diga que mandou o catálogo completo, " : ""}comente até 3 peças com um motivo real cada e convide a tocar em «Ver o catálogo» — NÃO repita a lista de preços e NUNCA chame isso de menu ou cardápio: é o catálogo.]`,
      );
    } else {
      lines.push(
        "[A lista tocável do catálogo foi enviada ao cliente. Responda em 1 ou 2 frases curtas: comente até 3 peças com um motivo real cada e convide a tocar em «Ver o catálogo» — NÃO repita a lista de preços e NUNCA chame isso de menu ou cardápio: é o catálogo.]",
      );
    }
    if (cortadasPeloTurno) {
      lines.push(
        `[Teto de ${CATALOG_MAX_LISTS_PER_CALL} listas por mensagem já alcançado neste turno: desta busca saiu só ${paraEnviar.length === 1 ? "a primeira lista" : `${paraEnviar.length} listas`}. Se a cliente quiser o resto desta busca, chame com pagina: ${paraEnviar.length + 1} numa PRÓXIMA mensagem dela — não agora.]`,
      );
    } else if (restantes > 0 && !recente) {
      lines.push(
        `[Há mais ${restantes} ${restantes === 1 ? "peça" : "peças"} além destas ${fatias.length * PAGE_SIZE}. NÃO chame pagina agora: pergunte se ela quer ver o resto ou sugira um filtro (categoria, cor, tamanho, preço); só numa PRÓXIMA mensagem dela chame listar_produtos com pagina: ${fatias.length + 1}.]`,
      );
    }

    // A lista é o atalho; o cartão é a vitrine: só com a primeira lista e só
    // com 2+ peças com foto (uma foto só já sai por detalhar_produto).
    const withPhoto = fatias[0].filter((item) => item.imagePath).slice(0, CARD_MAX_ITEMS);
    if (withPhoto.length >= 2) {
      const sent = await ctx.emitCard({
        kind: "catalog",
        title: catalogCardTitle(withPhoto.length),
        eyebrow: catalogCardEyebrow(filtros),
        items: withPhoto.map((item) => ({
          slug: item.slug,
          name: item.name,
          priceLabel: formatPriceRange(item.priceFromCents, item.priceToCents),
          imagePath: item.imagePath as string,
        })),
        caption: `Vitrine: ${withPhoto.map((item) => item.name).join(" · ")}`,
      });
      if (sent) {
        lines.push(
          `[Um cartão com as fotos de ${withPhoto.map((item) => item.name).join(", ")} ${
            sent === "sent" ? "foi enviado junto com a lista" : "chega logo depois da sua resposta"
          } — mencione em meia frase ("mandei um cartão com as três"), não descreva a imagem.]`,
        );
      }
    }
  } else if (restantes > 0) {
    lines.push(`[Há mais ${restantes} ${restantes === 1 ? "peça" : "peças"} além destas: filtre ou chame com pagina: ${fatias.length + 1}.]`);
  }
  return { ok: true, text: lines.join("\n") };
}

export async function execMontarLook(
  db: DbOrTx,
  ctx: ExecutorCtx,
  input: BotToolInputs["montar_look"],
): Promise<ToolResult> {
  // A viewer é a cliente da conversa: convidada VIP vê a peça escondida no look.
  const viewer = { customerId: ctx.customerId };
  const resolved = await resolveProductDetail(db, input.produto, viewer);
  if (resolved.kind === "none") {
    return {
      ok: false,
      text: `Não encontrei a peça "${input.produto}". Use o nome exato ou o slug de listar_produtos.`,
    };
  }
  if (resolved.kind === "ambiguous") {
    return {
      ok: true,
      text: `Há ${resolved.candidates.length} peças com "${input.produto}" no nome — chame de novo com o slug exato: ${resolved.candidates
        .slice(0, 6)
        .map((item) => `${item.name} (${item.slug})`)
        .join("; ")}.`,
    };
  }
  const { detail } = resolved;
  const heroPrice = Math.min(...detail.variants.map((variant) => variant.priceCents));
  const state = await readBotState(db, ctx);
  const heroColor = state.focus?.slug === detail.slug ? (state.focus.cor ?? null) : null;
  const heroImage = pickImagePath(detail.images, heroColor);

  // Fatos por peça (cores com estoque) e a cartela da cliente: peça só em
  // cor que ela evita fica fora do look; cor que ela ama ganha preferência.
  const [facts, styleProfile] = await Promise.all([
    listPublicVariantFacts(db, { viewer }),
    getStyleProfileByPhone(db, ctx.phoneE164),
  ]);
  const avoidColors = styleProfile?.profile.colorsAvoid ?? [];
  const loveColors = styleProfile?.profile.colorsLove ?? [];
  const picks = pickLookComplements(
    { id: detail.id, name: detail.name, categoryName: detail.categoryName, priceCents: heroPrice },
    facts.map(({ product: item, colorsAvailable }) => ({
      id: item.id,
      slug: item.slug,
      name: item.name,
      categoryName: item.categoryName,
      priceCents: item.priceFromCents,
      available: item.available,
      imagePath: item.imagePath,
      colors: colorsAvailable,
    })),
    {
      max: LOOK_MAX_COMPLEMENTS,
      avoidColors,
      loveColors,
      ...(input.orcamento_reais !== undefined ? { budgetCents: input.orcamento_reais * 100 } : {}),
    },
  );
  const cartelaNote =
    avoidColors.length > 0 || loveColors.length > 0
      ? `[Cartela considerada: ${[
          avoidColors.length > 0 ? `peças só em ${avoidColors.join(", ")} ficaram de fora` : "",
          loveColors.length > 0 ? `preferência por ${loveColors.join(", ")}` : "",
        ]
          .filter((part) => part !== "")
          .join("; ")}.]`
      : null;
  if (picks.length === 0) {
    return {
      ok: true,
      text: [
        `Nenhuma peça do catálogo completa ${detail.name} com honestidade (só há peças da mesma família, sem foto, esgotadas, fora do orçamento${avoidColors.length > 0 ? " ou só em cores que ela evita" : ""}). Não invente combinação: siga com a peça em vista.`,
        ...(cartelaNote ? [cartelaNote] : []),
      ].join("\n"),
    };
  }

  let cardSent: "sent" | "queued" | false = false;
  if (heroImage) {
    cardSent = await ctx.emitCard({
      kind: "look",
      title: lookCardTitle(detail.name),
      eyebrow: LOOK_EYEBROW,
      items: [
        { slug: detail.slug, name: detail.name, priceLabel: formatCentsBRL(heroPrice), imagePath: heroImage },
        ...picks.map((pick) => ({
          slug: pick.item.slug,
          name: pick.item.name,
          priceLabel: formatCentsBRL(pick.item.priceCents),
          imagePath: pick.item.imagePath as string,
        })),
      ],
      caption: `Look: ${detail.name} + ${picks.map((pick) => pick.item.name).join(" + ")}`,
    });
  }

  const total = heroPrice + picks.reduce((sum, pick) => sum + pick.item.priceCents, 0);
  const lines = [
    `Look com ${detail.name} (${formatCentsBRL(heroPrice)}):`,
    ...picks.map(
      (pick) => `• ${pick.item.name} — ${formatCentsBRL(pick.item.priceCents)} (${pick.reason}; slug ${pick.item.slug})`,
    ),
    `Total do look: ${formatCentsBRL(total)}.`,
    cardSent
      ? `[O cartão do look em imagem ${cardSent === "sent" ? "foi enviado à cliente" : "chega logo depois da sua resposta"} — mencione em meia frase, não descreva a imagem.]`
      : "[Sem cartão em imagem neste turno: apresente o look em texto, 1 frase por peça.]",
    ...(cartelaNote ? [cartelaNote] : []),
  ];
  return { ok: true, text: lines.join("\n") };
}

/**
 * Produto resolvido + a variante EXATA quando o cliente falou por SKU (é o
 * caso do toque na lista de variações): é dela que sai a cor da foto.
 */
export type ResolvedProduct =
  | { kind: "found"; detail: PublicProductDetail; matchedSku: string | null }
  | { kind: "ambiguous"; candidates: PublicProductListItem[] }
  | { kind: "none" };

/**
 * Resolve por slug exato (aceita o id 'produto:<slug>' da lista), depois SKU
 * exato (sem caixa), depois nome aproximado. Mais de uma peça com o termo no
 * nome NÃO escolhe em silêncio: devolve as candidatas para o modelo perguntar.
 */
export async function resolveProductDetail(
  db: DbOrTx,
  term: string,
  viewer?: { customerId: string | null },
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
        skuEquals(trimmed),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);
  if (bySku) {
    const detail = await getPublicProductBySlug(db, bySku.slug, viewer);
    if (detail) return { kind: "found", detail, matchedSku: bySku.sku };
  }

  const list = await listPublicProducts(db, { limit: 200, viewer });
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
  const detail = await getPublicProductBySlug(db, matches[0].slug, viewer);
  return detail ? { kind: "found", detail, matchedSku: null } : { kind: "none" };
}

export async function execDetalharProduto(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["detalhar_produto"],
): Promise<ToolResult> {
  const resolved = await resolveProductDetail(db, input.produto, { customerId: ctx.customerId });
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
  // quem tocou na lista): reoferecer só atrapalha. Com a cor já dita, a lista
  // mostra só aquela cor — e se sobrar UMA combinação disponível, a escolha
  // está feita: nada de lista, o SKU vai explícito para o modelo.
  let menuEmitted = false;
  let chosenVariantLine: string | null = null;
  if (ctx.onAttachment && matchedSku === null) {
    const ofColor = chosenColor
      ? detail.variants.filter(
          (variant) =>
            colorOfVariant(variant.attributes, axes)?.toLowerCase() ===
            chosenColor.toLowerCase(),
        )
      : [];
    const menuVariants = ofColor.length > 0 ? ofColor : detail.variants;
    const availableOfColor = ofColor.filter((variant) => variant.availableQty > 0);
    if (ofColor.length > 0 && availableOfColor.length === 1) {
      const only = availableOfColor[0];
      chosenVariantLine = `[Com a cor ${chosenColor}, só existe uma combinação disponível: ${variantLabel(only.attributes, axes)} = SKU ${only.sku}. Confirme com a cliente e siga para adicionar_a_sacola — não peça para escolher de novo.]`;
    } else {
      const menu = buildVariantMenu(detail.name, menuVariants, axes);
      if (menu) {
        ctx.onAttachment({ kind: "option_list", ...menu });
        menuEmitted = true;
      }
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
  } else if (detail.curatorNote) {
    lines.push("[Sem descrição cadastrada: sobre tecido e caimento, fique na nota da curadora e na ficha abaixo.]");
  } else {
    lines.push(
      "[Sem descrição cadastrada: não afirme tecido nem caimento — diga que confere com a equipe se a cliente perguntar.]",
    );
  }
  // A nota da curadora: o que ela diria de tecido, caimento e calor — a Lia cita.
  lines.push(
    ...curatorNoteLines({
      note: detail.curatorNote,
      hasAudio: detail.curatorAudioPath !== null,
      pageUrl: detail.publicNow ? `${siteBaseUrl()}/produto/${detail.slug}` : null,
      // Com o interruptor ligado (e a Lia podendo anexar), a linha aponta para a ferramenta.
      audioEnabled: detail.curatorAudioPath !== null && ctx.onAttachment !== undefined && (await isBotAudioNotesEnabled(db)),
    }),
  );
  // Ficha da peça: o que a placa de museu mostra, a Lia também sabe.
  if (detail.composition?.trim()) lines.push(`Composição: ${detail.composition.trim()}`);
  const careLabels = careNotesToLabels(parseCareNotes(detail.careNotes));
  if (careLabels.length > 0) lines.push(`Cuidados: ${careLabels.join(" · ")}`);
  if (detail.fitNotes?.trim()) lines.push(`Como veste: ${detail.fitNotes.trim()}`);
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
  const sizeChart = buildSizeChart(detail.variants, axes);
  if (isSizeChartEmpty(sizeChart)) {
    lines.push(
      "[Sem tabela de medidas cadastrada: não afirme medidas — diga que confere com a equipe.]",
    );
  } else {
    lines.push(...renderSizeChartLines(sizeChart));
  }
  if (detail.variants.every((variant) => variant.availableQty === 0)) {
    lines.push(
      "Atenção: esta peça está esgotada no momento. Ofereça outra parecida do catálogo ou avisar_quando_voltar (UMA mensagem quando voltar) — não avise o dono.",
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
  if (chosenVariantLine) lines.push(chosenVariantLine);
  return { ok: true, text: lines.join("\n") };
}

/** Variante vendável por SKU (case-insensitive) com o preço ATIVO de agora. */
export async function resolveVariantBySku(db: DbOrTx, sku: string) {
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
        skuEquals(sku),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Disponível agora (on_hand - reserved) da variante, 0 se não houver linha. */
export async function availableQtyOf(db: DbOrTx, variantId: string): Promise<number> {
  const [row] = await db
    .select({ onHand: stockLevels.onHand, reserved: stockLevels.reserved })
    .from(stockLevels)
    .where(eq(stockLevels.productVariantId, variantId))
    .limit(1);
  if (!row) return 0;
  return Math.max(0, row.onHand - row.reserved);
}

/** Combinação pelo SKU exato (sem caixa), com o rótulo para a resposta. */
export async function findVariantForBot(
  db: DbOrTx,
  sku: string,
): Promise<{ id: string; sku: string; label: string } | null> {
  const [row] = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      productName: products.name,
      attributesSchema: products.attributesSchema,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(skuEquals(sku), isNull(productVariants.deletedAt)))
    .limit(1);
  if (!row) return null;
  const axes = Array.isArray(row.attributesSchema) ? (row.attributesSchema as string[]) : [];
  const label = variantLabel((row.attributes ?? {}) as Record<string, string>, axes);
  return { id: row.id, sku: row.sku, label: `${row.productName}${label ? ` (${label})` : ""}` };
}
