// Uma peça voltou: registra, devolve ao estoque e fecha de um dos dois jeitos.
//
// Troca e reembolso parcial são o MESMO evento com finais diferentes — por
// isso um serviço só. O pedido não muda de status: ele segue 'delivered'
// (ou o que for), porque não foi reembolsado, uma peça voltou. 'refunded'
// continua querendo dizer "o pedido inteiro caiu".
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { fairReturnValue, type ReturnableItem } from "@/core/orders/item-returns";
import {
  auditLog,
  coupons,
  customers,
  financialEntries,
  orderItemReturns,
  orderItems,
  orders,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { issueCoupon } from "@/services/coupons";
import { ServiceError } from "@/services/orders";
import { applyStockEffectTx } from "@/services/stock";
import { firstNameOf, sendTemplateMessage } from "@/services/wa-messaging";
import { formatCentsBRL } from "@/lib/money";
import { spDayKey, spDayLabel } from "@/lib/sp-day";

/** Validade do crédito da troca: 90 dias é o mesmo fôlego do defeito em durável. */
const CREDIT_DAYS = 90;

/**
 * Recusa desta área, com mensagem pronta para a tela.
 *
 * Estende o ServiceError de orders de propósito: as telas de pedido traduzem
 * `instanceof ServiceError` para o texto da recusa, e uma classe solta caía no
 * "Algo deu errado, tente novamente" — uma recusa correta com cara de pane,
 * que foi o que assustou na primeira devolução de verdade.
 */
export class ReturnError extends ServiceError {}

const returnItemSchema = z.object({
  orderId: z.uuid(),
  orderItemId: z.uuid(),
  quantity: z.number().int().positive(),
  resolution: z.enum(["credito", "dinheiro"]),
  /** O dono pode ajustar o valor: dinheiro de cliente é decisão dele, não do rateio. */
  refundCents: z.number().int().min(0).optional(),
  reason: z.string().trim().max(500).optional(),
  userId: z.uuid(),
});

export type ReturnOrderItemInput = z.input<typeof returnItemSchema>;

export type ReturnOrderItemResult = {
  returnId: string;
  refundCents: number;
  resolution: "credito" | "dinheiro";
  /** Só no crédito: o código que a cliente usa na próxima compra. */
  couponCode: string | null;
  /** true = o rateio do cupom pode não refletir a regra dele; confira o valor. */
  needsReview: boolean;
};

/** Quanto já voltou de cada linha — devolver duas vezes a mesma peça é dinheiro em dobro. */
async function returnedQuantities(tx: DbOrTx, orderId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ orderItemId: orderItemReturns.orderItemId, total: sql<number>`sum(${orderItemReturns.quantity})::int` })
    .from(orderItemReturns)
    .where(and(eq(orderItemReturns.orderId, orderId), sql`${orderItemReturns.state} <> 'falhou'`))
    .groupBy(orderItemReturns.orderItemId);
  return new Map(rows.map((r) => [r.orderItemId, r.total]));
}

/**
 * Registra a devolução de uma peça. Tudo numa transação: se o estoque não
 * voltar, o crédito não nasce e o estorno não é pedido.
 */
export async function returnOrderItem(db: DbOrTx, input: ReturnOrderItemInput): Promise<ReturnOrderItemResult> {
  const parsed = returnItemSchema.parse(input);

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, parsed.orderId)).for("update");
    if (!order) throw new ReturnError("pedido_inexistente", "Pedido não encontrado.");
    if (order.paidAt === null) {
      throw new ReturnError("pedido_nao_pago", "Só dá para devolver peça de pedido pago.");
    }

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const item = items.find((row) => row.id === parsed.orderItemId);
    if (!item) throw new ReturnError("item_inexistente", "Esta peça não é deste pedido.");

    const jaVoltou = (await returnedQuantities(tx, order.id)).get(item.id) ?? 0;
    if (jaVoltou + parsed.quantity > item.quantity) {
      throw new ReturnError(
        "quantidade_excedida",
        `Desta peça já voltaram ${jaVoltou} de ${item.quantity}: não dá para devolver mais ${parsed.quantity}.`,
      );
    }

    // O cupom com escopo de item não é rateável com confiança: o pedido não
    // guarda quais peças eram elegíveis, só o id do cupom.
    const couponHadItemScope = order.couponId === null ? false : await hasItemScope(tx, order.couponId);
    const returnable: ReturnableItem[] = items.map((row) => ({ id: row.id, totalCents: row.totalCents, quantity: row.quantity }));
    const calculado = fairReturnValue(
      { items: returnable, discountCents: order.discountCents, couponHadItemScope },
      { itemId: item.id, quantity: parsed.quantity },
    );
    const refundCents = parsed.refundCents ?? calculado.refundCents;

    const [row] = await tx
      .insert(orderItemReturns)
      .values({
        orderId: order.id,
        orderItemId: item.id,
        quantity: parsed.quantity,
        refundCents,
        resolution: parsed.resolution,
        state: parsed.resolution === "credito" ? "concluida" : "pendente",
        reason: parsed.reason ?? null,
        createdBy: parsed.userId,
      })
      .returning({ id: orderItemReturns.id });
    const returnId = row!.id;

    // A peça volta à prateleira com vínculo ao pedido — o ajuste manual de
    // estoque, único caminho até aqui, deixava o movimento solto.
    await applyStockEffectTx(tx, {
      effect: "return",
      variantId: item.productVariantId,
      quantity: parsed.quantity,
      referenceType: "order",
      referenceId: order.id,
      createdBy: parsed.userId,
    });

    // Saída no caixa pelo valor PARCIAL (o reembolso total grava o total do pedido).
    if (refundCents > 0) {
      await tx.insert(financialEntries).values({
        direction: "payable",
        category: "refund",
        description: `Devolução de ${item.nameSnapshot} — pedido #${order.orderNumber}`,
        amountCents: refundCents,
        status: parsed.resolution === "credito" ? "canceled" : "pending",
        orderId: order.id,
        createdBy: parsed.userId,
      });
    }

    let couponCode: string | null = null;
    if (parsed.resolution === "credito" && refundCents > 0) {
      const [customer] = order.customerId
        ? await tx.select({ phoneE164: customers.phoneE164 }).from(customers).where(eq(customers.id, order.customerId))
        : [];
      const expiresAt = new Date(Date.now() + CREDIT_DAYS * 24 * 60 * 60 * 1000);
      const issued = await issueCoupon(tx, {
        dedupeKey: `troca:${returnId}`,
        customerId: order.customerId,
        phoneE164: customer?.phoneE164 ?? null,
        origin: "troca",
        type: "fixed",
        value: refundCents,
        expiresAt,
        note: `Crédito da devolução de ${item.nameSnapshot} (pedido #${order.orderNumber})`,
        orderId: order.id,
        maxUses: 1,
        perCustomerLimit: 1,
      });
      couponCode = issued.code;
      await tx.update(orderItemReturns).set({ couponId: issued.couponId, updatedAt: new Date() }).where(eq(orderItemReturns.id, returnId));
    }

    // Efeito externo pela fila (regra 5), na mesma transação do registro. No
    // crédito o aviso sai direto; no dinheiro ele espera o vendor devolver.
    await enqueueOutboxEvent(tx, {
      eventType: parsed.resolution === "dinheiro" ? "payment.refund_item" : "order.item_returned",
      dedupeKey: `${parsed.resolution === "dinheiro" ? "payment.refund_item" : "order.item_returned"}:${returnId}`,
      aggregateType: "order",
      aggregateId: order.id,
      payload: { returnId, orderId: order.id },
    });

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.item_returned",
      entityType: "order",
      entityId: order.id,
      after: { returnId, orderItemId: item.id, quantity: parsed.quantity, refundCents, resolution: parsed.resolution },
      reason: parsed.reason ?? null,
    });

    return { returnId, refundCents, resolution: parsed.resolution, couponCode, needsReview: calculado.needsReview };
  });
}

/** O cupom valia só para algumas peças? Então o rateio proporcional é palpite. */
async function hasItemScope(tx: DbOrTx, couponId: string): Promise<boolean> {
  const [row] = await tx
    .select({
      produtos: sql<number>`(select count(*)::int from coupon_products cp where cp.coupon_id = ${coupons.id})`,
      categorias: sql<number>`(select count(*)::int from coupon_categories cc where cc.coupon_id = ${coupons.id})`,
    })
    .from(coupons)
    .where(eq(coupons.id, couponId));
  return (row?.produtos ?? 0) > 0 || (row?.categorias ?? 0) > 0;
}

export type ItemRefundOutcome =
  | { action: "ja_estornado" }
  | { action: "sem_estorno_automatico" }
  | { action: "estornado"; refundId: string };

/**
 * Manda o Mercado Pago devolver o valor de UMA peça. A chave de idempotência
 * é por DEVOLUÇÃO — com a chave por pagamento, o segundo estorno parcial do
 * mesmo pedido seria descartado em silêncio e a cliente ficaria sem o dinheiro.
 *
 * Lança em falha do vendor: o retry/DLQ da fila cuida. Quem avisa a cliente é
 * o chamador, e só depois que isto retorna bem.
 */
export async function refundReturnedItem(
  db: DbOrTx,
  gateway: { refundPayment: (paymentId: string, options?: { amountCents?: number; idempotencyKey?: string }) => Promise<{ refundId: string; status: string }> },
  input: { returnId: string },
): Promise<ItemRefundOutcome> {
  const [devolucao] = await db
    .select({
      id: orderItemReturns.id,
      orderId: orderItemReturns.orderId,
      refundCents: orderItemReturns.refundCents,
      state: orderItemReturns.state,
      resolution: orderItemReturns.resolution,
    })
    .from(orderItemReturns)
    .where(eq(orderItemReturns.id, input.returnId));
  if (!devolucao) throw new Error(`refundReturnedItem: devolução ${input.returnId} não existe`);
  if (devolucao.state === "concluida") return { action: "ja_estornado" };
  if (devolucao.resolution !== "dinheiro") return { action: "sem_estorno_automatico" };

  const [order] = await db
    .select({ mpPaymentId: orders.mpPaymentId, paymentMethod: orders.paymentMethod })
    .from(orders)
    .where(eq(orders.id, devolucao.orderId));
  if (!order?.mpPaymentId) {
    // Pix manual ou dinheiro: quem devolve é o dono, por fora.
    await db.update(orderItemReturns).set({ state: "concluida", updatedAt: new Date() }).where(eq(orderItemReturns.id, devolucao.id));
    return { action: "sem_estorno_automatico" };
  }

  const refund = await gateway.refundPayment(order.mpPaymentId, {
    amountCents: devolucao.refundCents,
    idempotencyKey: `refund:${devolucao.id}`,
  });

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(orderItemReturns)
      .set({ state: "concluida", mpRefundId: refund.refundId, updatedAt: now })
      .where(eq(orderItemReturns.id, devolucao.id));
    // A saída do caixa deixa de ser "a pagar": o vendor já devolveu.
    await tx
      .update(financialEntries)
      .set({ status: "settled", updatedAt: now })
      .where(
        and(
          eq(financialEntries.orderId, devolucao.orderId),
          eq(financialEntries.category, "refund"),
          eq(financialEntries.status, "pending"),
          eq(financialEntries.amountCents, devolucao.refundCents),
        ),
      );
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "payment.item_refunded",
      entityType: "order",
      entityId: devolucao.orderId,
      after: { returnId: devolucao.id, mpRefundId: refund.refundId, refundCents: devolucao.refundCents },
      reason: "Estorno parcial confirmado pelo Mercado Pago",
    });
  });

  return { action: "estornado", refundId: refund.refundId };
}

/** Esgotadas as tentativas: fica registrado que o dinheiro NÃO voltou. */
export async function markItemRefundFailed(db: DbOrTx, input: { returnId: string }): Promise<void> {
  await db.update(orderItemReturns).set({ state: "falhou", updatedAt: new Date() }).where(eq(orderItemReturns.id, input.returnId));
}

// ---------------------------------------------------------------------------
// Avisos à cliente
// ---------------------------------------------------------------------------

/** Contexto do aviso: quem, qual peça, quanto, e o crédito quando houver. */
async function loadReturnNotice(db: DbOrTx, returnId: string) {
  const [row] = await db
    .select({
      refundCents: orderItemReturns.refundCents,
      resolution: orderItemReturns.resolution,
      couponId: orderItemReturns.couponId,
      peca: orderItems.nameSnapshot,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      phoneE164: customers.phoneE164,
      fullName: customers.fullName,
    })
    .from(orderItemReturns)
    .innerJoin(orderItems, eq(orderItems.id, orderItemReturns.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItemReturns.orderId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orderItemReturns.id, returnId));
  return row ?? null;
}

/** Cliente: a peça voltou e o dinheiro saiu (ou o crédito nasceu). */
export async function sendReturnNoticeWa(
  db: DbOrTx,
  provider: Parameters<typeof sendTemplateMessage>[1],
  input: { returnId: string },
): Promise<Awaited<ReturnType<typeof sendTemplateMessage>> | { skipped: string }> {
  const ctx = await loadReturnNotice(db, input.returnId);
  if (!ctx) return { skipped: "devolucao_inexistente" };
  if (!ctx.phoneE164) return { skipped: "sem_telefone" };

  const vars: Record<string, string> = {
    nome: firstNameOf(ctx.fullName ?? ""),
    pedido: String(ctx.orderNumber),
    peca: ctx.peca,
    valor: formatCentsBRL(ctx.refundCents),
  };

  if (ctx.resolution === "credito") {
    if (!ctx.couponId) return { skipped: "sem_cupom" };
    const [cupom] = await db
      .select({ code: coupons.code, expiresAt: coupons.expiresAt })
      .from(coupons)
      .where(eq(coupons.id, ctx.couponId));
    if (!cupom) return { skipped: "sem_cupom" };
    vars.cupom = cupom.code;
    vars.validade = cupom.expiresAt ? spDayLabel(spDayKey(cupom.expiresAt)) : "—";
  }

  return sendTemplateMessage(db, provider, {
    templateKey: ctx.resolution === "credito" ? "order_item_credit" : "order_item_refunded",
    phoneE164: ctx.phoneE164,
    vars,
    customerId: ctx.customerId,
    orderId: ctx.orderId,
    dedupeKey: `wa.order_item_return:${input.returnId}`,
    // Aviso do pedido dela: sempre vai (o opt-in é de novidades e ofertas).
    requireOptIn: false,
  });
}

export type ReturnableItemView = {
  id: string;
  label: string;
  remaining: number;
  unitRefundCents: number;
  needsReview: boolean;
};

/**
 * O que ainda pode voltar deste pedido, com o valor de UMA unidade já sem a
 * parte do cupom. A tela só mostra — a conta é daqui.
 */
export async function listReturnableItems(db: DbOrTx, orderId: string): Promise<ReturnableItemView[]> {
  const [order] = await db
    .select({ discountCents: orders.discountCents, couponId: orders.couponId, paidAt: orders.paidAt })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order || order.paidAt === null) return [];

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const jaVoltou = await returnedQuantities(db, orderId);
  const couponHadItemScope = order.couponId === null ? false : await hasItemScope(db, order.couponId);
  const returnable: ReturnableItem[] = items.map((row) => ({ id: row.id, totalCents: row.totalCents, quantity: row.quantity }));

  return items
    .map((row) => {
      const remaining = row.quantity - (jaVoltou.get(row.id) ?? 0);
      if (remaining <= 0) return null;
      const { refundCents, needsReview } = fairReturnValue(
        { items: returnable, discountCents: order.discountCents, couponHadItemScope },
        { itemId: row.id, quantity: 1 },
      );
      return { id: row.id, label: `${row.nameSnapshot} (${row.skuSnapshot})`, remaining, unitRefundCents: refundCents, needsReview };
    })
    .filter((row): row is ReturnableItemView => row !== null);
}
