// Fechamento e pós-venda pela vendedora: criar_pedido, status_do_pedido, enviar_chave_pix.
import { and, asc, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { getPaymentGateway } from "@/adapters/mercadopago";
import {
  BOT_ORDER_STATUS_LABELS,
  isPurchasedStatus,
  PURCHASE_HISTORY_LIMIT,
  PURCHASED_STATUSES,
  purchaseMemoryLine,
  summarizePurchaseHistory,
  type PurchaseOrderSummary,
} from "@/core/bot/purchases";
import { confirmQuoteUnchanged, resolveApprovedQuote, withoutMotoboy } from "@/core/bot/shipping";
import type { BotToolInputs } from "@/core/bot/tools";
import { variantLabel } from "@/core/catalog/attributes";
import { auditLog, customers, orderItems, orders, products, productVariants, waConversations } from "@/db/schema";
import { formatDateTimeSP } from "@/emails/templates";
import { isValidCpf } from "@/lib/document";
import { formatCentsBRL } from "@/lib/money";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { computeTotalWeightGrams, quoteShipping } from "@/services/store-catalog";
import {
  createStoreOrder,
  PriceChangedError,
  ServiceError,
  ShippingChangedError,
} from "@/services/store-orders";
import { ensurePaymentPreference, isMpEnabled } from "@/services/store-payments";
import { orderPublicUrl } from "@/services/wa-messaging";

import { resolveVariantBySku } from "./catalog";
import { loadSavedRegistration, resolveSavedIdentity } from "./customer";
import type { OrderIdentity } from "./customer";
import { DRY_RUN_TEXT, PIX_MANUAL_TTL_HOURS, readBotState, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";
import { markSiteCartOrdered } from "@/services/site-carts";

export const ORDER_STATUS_LABELS = BOT_ORDER_STATUS_LABELS;

export async function execCriarPedido(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["criar_pedido"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  const state = await readBotState(db, ctx);
  let identity: OrderIdentity;

  if (input.usar_cadastro_salvo) {
    // Caminho do cliente recorrente: os dados REAIS saem do banco, então o CPF
    // nunca passa pelo modelo nem por uma mensagem de WhatsApp.
    const registration = await loadSavedRegistration(db, ctx.phoneE164);
    if (!registration) {
      return {
        ok: false,
        text: "Não consegui reaproveitar o cadastro deste telefone (não existe). Colete nome, CPF e endereço com o cliente, um dado por vez, e chame criar_pedido com os campos preenchidos.",
      };
    }
    if (input.cep !== undefined) {
      // Endereço novo dito pela cliente (o schema já exigiu todos os campos):
      // nome e CPF do cadastro, entrega no endereço informado.
      identity = {
        fullName: registration.fullName,
        documentDigits: (registration.documentDigits ?? "").replace(/\D/g, ""),
        postalCode: input.cep,
        street: input.rua ?? "",
        number: input.numero ?? "",
        ...(input.complemento !== undefined ? { complement: input.complemento } : {}),
        district: input.bairro ?? "",
        city: input.cidade ?? "",
        state: input.uf ?? "",
      };
    } else {
      const resolved = resolveSavedIdentity(registration, state.lastCep);
      if (!resolved.ok) return resolved;
      identity = resolved.identity;
    }
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

  // Frete: SÓ a cotação que a cliente viu nesta conversa, para o CEP do
  // endereço de entrega (o caderninho guarda CEP, opções e escolha). Depois,
  // recota com o peso real e confere que a tarifa aprovada não mudou.
  const approved = resolveApprovedQuote({
    quotedCep: state.lastCep,
    quotes: state.lastQuotes,
    quotedAt: state.lastQuotedAt,
    chosenRateId: state.chosenRateId,
    orderCep: identity.postalCode,
    freteInput: input.frete,
  });
  if (!approved.ok) return approved;

  const totalWeightGrams = computeTotalWeightGrams(
    resolved.map((r) => ({ weightGrams: r.weightGrams, quantity: r.quantity })),
  );
  const fresh = withoutMotoboy(
    await quoteShipping(db, {
      cep: identity.postalCode,
      totalWeightGrams,
    }),
  );
  const confirmed = confirmQuoteUnchanged(approved.quote, fresh, identity.postalCode);
  if (!confirmed.ok) return confirmed;
  const chosen = confirmed.quote;

  const isCash = input.forma_de_pagamento === "dinheiro_na_entrega";

  // Cupom: o que veio no campo; ausente, o que validar_cupom confirmou nesta
  // conversa (cupom vazio = explicitamente sem cupom). O serviço revalida.
  const couponCode =
    input.cupom !== undefined ? input.cupom.trim() : (state.coupon?.code ?? "");

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
      ...(couponCode !== "" ? { couponCode } : {}),
      ...(input.presente
        ? {
            gift: {
              recipientName: input.presente.para,
              ...(input.presente.bilhete ? { message: input.presente.bilhete } : {}),
              ...(input.presente.entregar_ate ? { deliverBy: input.presente.entregar_ate } : {}),
            },
          }
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
      // Cupom do caderninho (aplicado sozinho) recusado agora: esquece e diz
      // ao modelo — senão todo criar_pedido seguinte tropeça no mesmo cupom.
      const savedCouponFailed =
        error instanceof ServiceError &&
        error.code.startsWith("COUPON_") &&
        input.cupom === undefined &&
        state.coupon !== undefined;
      if (savedCouponFailed) {
        await updateBotState(db, ctx, (current) => ({ ...current, coupon: undefined }));
        return {
          ok: false,
          text: `${error.message}\n[O cupom ${couponCode}, validado antes nesta conversa, foi aplicado sozinho e recusado agora; já o esqueci. Avise a cliente e chame criar_pedido de novo para fechar sem cupom — ou valide outro código com validar_cupom.]`,
        };
      }
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
        lastCep: undefined,
        lastQuotes: undefined,
        lastQuotedAt: undefined,
        chosenRateId: undefined,
        coupon: undefined,
        // A ponte cumpriu o papel: o próximo turno é outra conversa.
        bridge: undefined,
        focus: undefined,
        lastOrderNumber: created.orderNumber,
      },
      updatedAt: new Date(),
    })
    .where(eq(waConversations.id, ctx.conversationId));
  // A ponte do site (se houver) ganha o pedido: o funil "de onde vieram" conta a venda.
  await markSiteCartOrdered(db, { conversationId: ctx.conversationId, orderId: created.orderId });

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
    ...(input.presente
      ? [
          `🎁 Presente para ${input.presente.para} — ${input.presente.bilhete ? "bilhete incluído" : "sem bilhete"}, sem preço na embalagem.`,
        ]
      : []),
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
export async function resolveConversationCustomerId(
  db: DbOrTx,
  ctx: Pick<BotExecutorContext, "customerId" | "phoneE164">,
): Promise<string | null> {
  // Cliente apagada ou anonimizada (LGPD) nunca volta pela conversa — nem
  // pelo vínculo gravado, nem pelo telefone.
  const alive = [isNull(customers.deletedAt), isNull(customers.anonymizedAt)];
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      ctx.customerId
        ? and(eq(customers.id, ctx.customerId), ...alive)
        : and(eq(customers.phoneE164, ctx.phoneE164), ...alive),
    )
    .limit(1);
  return customer?.id ?? null;
}

export async function execStatusDoPedido(
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
 * Últimos pedidos de uma cliente com as peças (nome do pedido + variação
 * atual da combinação). Rascunho fica de fora (nunca chegou a ser pedido).
 */
export async function loadPurchaseHistory(
  db: DbOrTx,
  customerId: string,
  opts: { limit: number; onlyPurchased?: boolean },
): Promise<PurchaseOrderSummary[]> {
  const conditions = [eq(orders.customerId, customerId), ne(orders.status, "draft")];
  if (opts.onlyPurchased) conditions.push(inArray(orders.status, [...PURCHASED_STATUSES]));
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      createdAt: orders.createdAt,
      totalCents: orders.totalCents,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.orderNumber))
    .limit(opts.limit);
  if (rows.length === 0) return [];

  const items = await db
    .select({
      orderId: orderItems.orderId,
      name: orderItems.nameSnapshot,
      quantity: orderItems.quantity,
      attributes: productVariants.attributes,
      attributesSchema: products.attributesSchema,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(orderItems.orderId, rows.map((row) => row.id)))
    .orderBy(asc(orderItems.nameSnapshot), asc(orderItems.id));

  return rows.map((row) => ({
    orderNumber: row.orderNumber,
    status: row.status,
    createdAt: row.createdAt,
    totalCents: row.totalCents,
    items: items
      .filter((item) => item.orderId === row.id)
      .map((item) => {
        const axes = Array.isArray(item.attributesSchema) ? (item.attributesSchema as string[]) : [];
        return {
          name: item.name,
          variantLabel: variantLabel((item.attributes ?? {}) as Record<string, string>, axes),
          quantity: item.quantity,
        };
      }),
  }));
}

/** Ferramenta historico_de_compras: só lê, então vale também no ensaio (dryRun). */
export async function execHistoricoDeCompras(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<ToolResult> {
  const customerId = await resolveConversationCustomerId(db, ctx);
  if (!customerId) return { ok: true, text: summarizePurchaseHistory([]) };
  const history = await loadPurchaseHistory(db, customerId, { limit: PURCHASE_HISTORY_LIMIT });
  return { ok: true, text: summarizePurchaseHistory(history) };
}

/**
 * Linha "Compras anteriores" do caderninho: a compra paga mais recente e
 * quantas compras pagas o telefone tem. Null para quem nunca comprou.
 */
export async function purchaseMemoryLineFor(
  db: DbOrTx,
  ctx: Pick<BotExecutorContext, "customerId" | "phoneE164">,
): Promise<string | null> {
  const customerId = await resolveConversationCustomerId(db, ctx);
  if (!customerId) return null;
  const [latest] = await loadPurchaseHistory(db, customerId, { limit: 1, onlyPurchased: true });
  if (!latest || !isPurchasedStatus(latest.status)) return null;
  const [row] = await db
    .select({ total: count() })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, [...PURCHASED_STATUSES])));
  return purchaseMemoryLine(latest, Number(row?.total ?? 0));
}

/**
 * Plano B de pagamento: envia a chave Pix da loja para o cliente pagar por
 * transferência manual. Guardas: chave cadastrada (store_pix_key) E pedido
 * pending_payment do cliente DESTA conversa. Marca payment_method
 * 'pix_manual', estende o prazo para now+24h quando o atual é menor (e
 * não-nulo — cash sem prazo continua sem prazo) e avisa o dono via outbox
 * com dedupe por pedido+inbound (retry do turno nunca duplica o aviso).
 */
export async function execEnviarChavePix(
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
