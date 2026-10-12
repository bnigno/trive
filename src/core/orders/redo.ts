// "Refazer pedido": a cliente quer mudar um pedido que ainda NÃO foi pago
// (tirar o cupom, pagar em dinheiro, trocar o tamanho, mudar o bilhete ou a
// entrega). O pedido antigo é cancelado e nasce um NÚMERO NOVO com as
// mudanças — estoque e cupom passam direto, tudo numa transação (o service).
// PURO: quem pode refazer, o plano do pedido novo e o resumo das mudanças.
// Antes disto, toda mudança virava transferência para a equipe e o pedido
// pendente segurava estoque e cupom até vencer (casos #1030, #1020).

export type RedoBlocker =
  | "already_redone"
  | "not_pending"
  | "reservation_expired"
  | "money_received"
  | "manual_channel"
  | "packed"
  | "dispatched"
  | "in_route"
  | "payment_attempt"
  | "pix_manual";

export interface RedoEligibilityInput {
  orderNumber: number;
  status: string;
  channel: string;
  packagePhotoPath: string | null;
  dispatchedAt: string | null;
  hasOpenDeliveryStop: boolean;
  mpPaymentId: string | null;
  /** O prazo de pagamento já passou (o cron ainda não cancelou). */
  reservationExpired: boolean;
  /** Dinheiro na entrega já baixado no financeiro: o pedido é pago, não refeito. */
  saleSettled: boolean;
  /** 'pix_manual' = ela recebeu a chave Pix e pode já ter transferido. */
  paymentMethod: string | null;
  replacedByOrderNumber: number | null;
}

/** O que impede refazer, na ordem de importância (o primeiro é o que se diz). */
export function redoBlockers(order: RedoEligibilityInput): RedoBlocker[] {
  const blockers: RedoBlocker[] = [];
  if (order.replacedByOrderNumber !== null) blockers.push("already_redone");
  if (order.status !== "pending_payment") blockers.push("not_pending");
  if (order.reservationExpired) blockers.push("reservation_expired");
  if (order.saleSettled) blockers.push("money_received");
  if (order.channel !== "store" && order.channel !== "whatsapp") blockers.push("manual_channel");
  if (order.packagePhotoPath !== null) blockers.push("packed");
  if (order.dispatchedAt !== null) blockers.push("dispatched");
  if (order.hasOpenDeliveryStop) blockers.push("in_route");
  if (order.mpPaymentId !== null) blockers.push("payment_attempt");
  if (order.paymentMethod === "pix_manual") blockers.push("pix_manual");
  return blockers;
}

/** Só um pagamento possível (Mercado Pago ou Pix manual) a equipe pode passar por cima — depois de conferir que nada foi pago. */
export function isOverridableBlocker(blocker: RedoBlocker): boolean {
  return blocker === "payment_attempt" || blocker === "pix_manual";
}

export function redoBlockerMessage(blocker: RedoBlocker, order: Pick<RedoEligibilityInput, "orderNumber" | "replacedByOrderNumber">): string {
  switch (blocker) {
    case "already_redone":
      return `O pedido #${order.orderNumber} já foi refeito: agora ele é o #${order.replacedByOrderNumber}.`;
    case "not_pending":
      return `O pedido #${order.orderNumber} não está aguardando pagamento — só dá para refazer pedido ainda não pago.`;
    case "reservation_expired":
      return `A reserva do pedido #${order.orderNumber} já venceu: as peças voltam para a loja e o pedido é cancelado sozinho. Faça um pedido novo.`;
    case "money_received":
      return `O dinheiro do pedido #${order.orderNumber} já foi baixado no financeiro: marque como pago em vez de refazer.`;
    case "manual_channel":
      return `O pedido #${order.orderNumber} é uma venda manual do painel: cancele e faça uma venda manual nova.`;
    case "packed":
      return `O pedido #${order.orderNumber} já foi embalado: não dá mais para refazer.`;
    case "dispatched":
      return `O pedido #${order.orderNumber} já saiu para entrega.`;
    case "in_route":
      return `O pedido #${order.orderNumber} está numa saída do motoboy — tire da saída antes de refazer.`;
    case "payment_attempt":
      return `Há um pagamento em andamento no Mercado Pago para o pedido #${order.orderNumber}: confira se ela já pagou antes de refazer (refazer faria ela pagar de novo).`;
    case "pix_manual":
      return `Ela recebeu a chave Pix do pedido #${order.orderNumber}: confira no banco se ela já transferiu antes de refazer (refazer faria ela pagar de novo).`;
  }
}

export type DeliveryWindowSnapshot = {
  dayKey: string;
  start: string;
  end: string;
  cutoff: string;
  rateName: string;
  label: string;
  dispatchedAt?: string;
};

/** A entrega do pedido antigo, como foi contratada: o pedido novo herda sem cotar de novo. */
export type KeptShipping = {
  kind: "motoboy" | "correios";
  /** Preço da opção ANTES do cupom (o frete grátis do cupom é refeito no pedido novo). */
  listPriceCents: number;
  service: string | null;
  quoteId: string | null;
  deliveryWindow: DeliveryWindowSnapshot | null;
  neededBy: string | null;
  occasion: string | null;
  shipBy: string | null;
};

export function snapshotKeptShipping(
  order: {
    shippingCents: number;
    shippingService: string | null;
    shippingQuoteId: string | null;
    deliveryWindow: DeliveryWindowSnapshot | null;
    neededBy: string | null;
    occasion: string | null;
    shipBy: string | null;
  },
  couponShippingDiscountCents: number,
): KeptShipping {
  const window = order.deliveryWindow;
  return {
    kind: window ? "motoboy" : "correios",
    listPriceCents: order.shippingCents + couponShippingDiscountCents,
    service: order.shippingService,
    quoteId: order.shippingQuoteId,
    // A saída do motoboy (dispatchedAt) é do pedido antigo — o novo nasce sem ela.
    deliveryWindow: window
      ? { dayKey: window.dayKey, start: window.start, end: window.end, cutoff: window.cutoff, rateName: window.rateName, label: window.label }
      : null,
    neededBy: order.neededBy,
    occasion: order.occasion,
    shipBy: order.shipBy,
  };
}

export type RedoItem = { variantId: string; quantity: number; expectedUnitPriceCents: number };
export type RedoGift = { recipientName: string; message: string | null; deliverBy: string | null };

export type CouponChange = { kind: "keep" } | { kind: "remove" } | { kind: "code"; code: string };
export type GiftChange = { kind: "keep" } | { kind: "remove" } | { kind: "set"; recipientName: string; message: string | null };
export type DeliveryChange =
  | { kind: "keep" }
  | {
      kind: "ship";
      shippingRateId: string;
      expectedShippingCents: number;
      deliveryWindow?: { dayKey: string; start: string; end: string; cutoff: string };
      neededBy?: string;
      occasion?: string;
      /** Rótulo para o resumo ("Motoboy · amanhã 14h–18h"). */
      label: string;
    };

export interface RedoChanges {
  coupon?: CouponChange;
  paymentMethod?: "online" | "cash";
  /** Lista completa das peças do pedido novo (substitui a antiga). */
  items?: RedoItem[];
  gift?: GiftChange;
  delivery?: DeliveryChange;
}

export interface RedoSource {
  couponCode: string | null;
  paymentMethod: string | null;
  items: RedoItem[];
  gift: RedoGift | null;
  createdAt: Date;
  kept: KeptShipping;
  weightGrams: number;
}

export interface RedoPlan {
  couponCode: string | null;
  /** Cupom mantido vale como na data do pedido antigo (horário, validade, degraus). */
  couponAsOf: Date | null;
  paymentMethod: "online" | "cash";
  items: RedoItem[];
  gift: RedoGift | null;
  delivery: { kind: "keep"; kept: KeptShipping } | Extract<DeliveryChange, { kind: "ship" }>;
}

export type RedoPlanResult =
  | { ok: true; plan: RedoPlan }
  | { ok: false; code: "REDO_NO_CHANGES" | "REDO_SHIPPING_NEEDS_QUOTE" | "REDO_WINDOW_PAST"; message: string };

function sameItems(a: readonly RedoItem[], b: readonly RedoItem[]): boolean {
  const key = (items: readonly RedoItem[]) =>
    items
      .map((item) => `${item.variantId}:${item.quantity}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

/** Também o preço: o "preço de hoje" aceito por ela entra no resumo, mesmo com as mesmas peças. */
function sameItemsAndPrices(a: readonly RedoItem[], b: readonly RedoItem[]): boolean {
  const key = (items: readonly RedoItem[]) =>
    items
      .map((item) => `${item.variantId}:${item.quantity}:${item.expectedUnitPriceCents}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

function sameGift(a: RedoGift | null, b: RedoGift | null): boolean {
  if (a === null || b === null) return a === b;
  return a.recipientName === b.recipientName && (a.message ?? "") === (b.message ?? "");
}

/** Pix manual e os meios do Mercado Pago são "pelo link"; só dinheiro na entrega é "cash". */
export function redoPaymentMethodOf(paymentMethod: string | null): "online" | "cash" {
  return paymentMethod === "cash" ? "cash" : "online";
}

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function buildRedoPlan(
  src: RedoSource,
  changes: RedoChanges,
  ctx: { newWeightGrams: number; todayKey: string; /** Minuto do dia em São Paulo. */ nowMinutes: number },
): RedoPlanResult {
  const coupon = changes.coupon ?? { kind: "keep" };
  const couponCode =
    coupon.kind === "keep" ? src.couponCode : coupon.kind === "remove" ? null : coupon.code.trim().toUpperCase() || null;
  const couponAsOf = coupon.kind === "keep" && src.couponCode !== null ? src.createdAt : null;

  const paymentMethod = changes.paymentMethod ?? redoPaymentMethodOf(src.paymentMethod);
  // As peças que vieram valem com o preço que vieram (o "preço de hoje" aceito pela cliente).
  const items = changes.items ?? src.items;

  const giftChange = changes.gift ?? { kind: "keep" };
  const gift: RedoGift | null =
    giftChange.kind === "keep"
      ? src.gift
      : giftChange.kind === "remove"
        ? null
        : { recipientName: giftChange.recipientName, message: giftChange.message, deliverBy: src.gift?.deliverBy ?? null };

  const delivery = changes.delivery ?? { kind: "keep" };
  if (delivery.kind === "keep") {
    // A entrega mantida tem o preço da faixa do peso antigo: peça mais pesada (ou leve) pede escolher de novo.
    if (ctx.newWeightGrams !== src.weightGrams) {
      return {
        ok: false,
        code: "REDO_SHIPPING_NEEDS_QUOTE",
        message: "As peças mudaram de peso: escolha a entrega de novo para o frete sair certo.",
      };
    }
    const window = src.kept.deliveryWindow;
    if (window && window.dayKey < ctx.todayKey) {
      return {
        ok: false,
        code: "REDO_WINDOW_PAST",
        message: `O dia da entrega combinada (${window.label}) já passou: escolha um horário novo.`,
      };
    }
    if (window && window.dayKey === ctx.todayKey) {
      // Hoje: a janela que já terminou não volta; pagar pelo link depois da
      // hora-limite também não sai hoje (o checkout recusaria igual).
      const payingOnline = (changes.paymentMethod ?? redoPaymentMethodOf(src.paymentMethod)) === "online";
      if (ctx.nowMinutes >= minutesOf(window.end) || (payingOnline && ctx.nowMinutes >= minutesOf(window.cutoff))) {
        return {
          ok: false,
          code: "REDO_WINDOW_PAST",
          message: `A entrega combinada (${window.label}) não dá mais para hoje: escolha um horário novo.`,
        };
      }
    }
  }

  const unchanged =
    couponCode === src.couponCode &&
    paymentMethod === redoPaymentMethodOf(src.paymentMethod) &&
    sameItems(items, src.items) &&
    sameGift(gift, src.gift) &&
    delivery.kind === "keep";
  if (unchanged) {
    return { ok: false, code: "REDO_NO_CHANGES", message: "Nada muda: o pedido novo seria igual ao atual." };
  }

  return {
    ok: true,
    plan: {
      couponCode,
      couponAsOf,
      paymentMethod,
      items,
      gift,
      delivery: delivery.kind === "keep" ? { kind: "keep", kept: src.kept } : delivery,
    },
  };
}

/** O que mudou, em frases curtas para a cliente e a dona ("cupom X retirado", "pagamento: dinheiro na entrega"…). */
export function describeOrderChanges(
  src: RedoSource,
  plan: RedoPlan,
  itemLabel: (item: RedoItem) => string,
): string[] {
  const changes: string[] = [];
  if (plan.couponCode !== src.couponCode) {
    if (src.couponCode && !plan.couponCode) changes.push(`cupom ${src.couponCode} retirado`);
    else if (plan.couponCode) changes.push(src.couponCode ? `cupom trocado: ${plan.couponCode}` : `cupom ${plan.couponCode} aplicado`);
  }
  if (plan.paymentMethod !== redoPaymentMethodOf(src.paymentMethod)) {
    changes.push(plan.paymentMethod === "cash" ? "pagamento: dinheiro na entrega" : "pagamento: pelo link (Pix ou cartão)");
  }
  if (!sameItemsAndPrices(plan.items, src.items)) {
    changes.push(`peças: ${plan.items.map(itemLabel).join(", ")}`);
  }
  if (!sameGift(plan.gift, src.gift)) {
    if (src.gift && !plan.gift) changes.push("deixou de ser presente");
    else if (!src.gift && plan.gift) changes.push(`presente para ${plan.gift.recipientName}`);
    else changes.push("bilhete do presente atualizado");
  }
  if (plan.delivery.kind === "ship") changes.push(`entrega: ${plan.delivery.label}`);
  return changes;
}

/**
 * Pagaram um pedido JÁ cancelado (o link antigo de um pedido refeito, ou a
 * reserva que venceu): o que a dona faz. `latest` = o fim da cadeia de
 * pedidos refeitos (o #B, ou o #C se o #B também foi refeito).
 */
export function paidCanceledOrderGuidance(input: {
  orderNumber: number;
  latest: { orderNumber: number; status: string } | null;
}): string {
  const { latest } = input;
  if (!latest) {
    return "A reserva tinha vencido (ou o pedido foi cancelado). Confira se as peças ainda estão em estoque: faça uma venda manual para ela com este pagamento ou estorne no Mercado Pago.";
  }
  if (latest.status === "pending_payment") {
    return `Ele foi refeito e agora é o #${latest.orderNumber}, ainda aguardando pagamento: ela pagou o link antigo. Estorne este pagamento no Mercado Pago e mande a ela o link do #${latest.orderNumber}.`;
  }
  if (latest.status === "canceled") {
    return `Ele foi refeito como #${latest.orderNumber}, que também está cancelado. Fale com ela: faça uma venda manual com este pagamento ou estorne no Mercado Pago.`;
  }
  return `Ele foi refeito como #${latest.orderNumber}, que já foi pago: ela pagou duas vezes. Estorne este pagamento no Mercado Pago.`;
}
