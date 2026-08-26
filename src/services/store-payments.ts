// Pagamento automático da LOJA (Fase 3): criação de preference do Checkout
// Pro para pedidos pending_payment. A confirmação de pagamento NÃO acontece
// aqui — ela chega pelo webhook, que reconsulta a API e transiciona o pedido.
//
// O gateway é INJETADO (testes usam fakes) e este serviço só depende do
// pedaço do contrato que consome (porta estreita, tipagem estrutural) — nenhum
// tipo do vendor vaza para cá.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getAdapterMode } from "@/adapters/adapter-mode";
import { auditLog, customers, orderItems, orders } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/orders";
import { getSettingsMap } from "@/services/settings";

export { ServiceError };

// ---------------------------------------------------------------------------
// Porta do gateway (subconjunto do contrato PaymentGateway da Fase 3)
// ---------------------------------------------------------------------------

export interface CheckoutPreferenceItem {
  title: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CreateCheckoutPreferenceInput {
  orderId: string;
  orderNumber: number;
  /** Sempre = orderId: é o elo pedido↔pagamento que o webhook usa. */
  externalReference: string;
  items: CheckoutPreferenceItem[];
  payerEmail?: string;
  /** Página pública do pedido — o MP devolve o cliente para cá. */
  backUrl: string;
  notificationUrl?: string;
}

/** Só o que este serviço consome do PaymentGateway (adapters/mercadopago). */
export interface StorePaymentGateway {
  createCheckoutPreference(
    input: CreateCheckoutPreferenceInput,
  ): Promise<{ preferenceId: string; initPointUrl: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SITE_URL = "https://trivemaison.com.br";

export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  const site = raw && raw.trim() !== "" ? raw.trim() : DEFAULT_SITE_URL;
  return site.replace(/\/+$/, "");
}

/**
 * Pagamento automático está LIGADO? Exige o toggle mp_enabled E condições de
 * funcionar: em ADAPTER_MODE fake o gateway simulado dispensa credenciais;
 * em modo real é preciso MP_ACCESS_TOKEN. Sem isso a loja segue no fluxo
 * manual (WhatsApp/Pix) — NADA quebra com credenciais ausentes.
 */
export async function isMpEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["mp_enabled"]);
  if (map["mp_enabled"] !== true) return false;
  if (getAdapterMode() === "fake") return true;
  const token = process.env.MP_ACCESS_TOKEN;
  return typeof token === "string" && token.trim() !== "";
}

// ---------------------------------------------------------------------------
// ensurePaymentPreference
// ---------------------------------------------------------------------------

const ensureInputSchema = z.object({ orderId: z.uuid() });

export interface EnsurePaymentPreferenceResult {
  preferenceId: string;
  initPointUrl: string;
}

/**
 * Garante uma preference de Checkout Pro utilizável para o pedido e retorna a
 * URL de pagamento (init_point).
 *
 * Por que CRIAR uma preference nova a cada chamada, mesmo quando
 * mpPreferenceId já existe? O init_point do Checkout Pro não é recuperável
 * depois da criação (a API de preferences não devolve uma URL clicável
 * confiável para reuso) — então "reaproveitar" a preference antiga deixaria o
 * cliente sem link. Recriar é seguro: preferences não cobram nada por si; a
 * IDEMPOTÊNCIA do pagamento vem do external_reference (= orderId) que o
 * webhook usa para casar pagamento↔pedido, e de X-Idempotency-Key nas
 * chamadas do adapter — nunca da preference. Guardamos sempre a mais recente
 * em orders.mpPreferenceId para rastreio/conciliação.
 */
export async function ensurePaymentPreference(
  db: DbOrTx,
  gateway: StorePaymentGateway,
  input: { orderId: string },
): Promise<EnsurePaymentPreferenceResult> {
  const parsed = ensureInputSchema.parse(input);

  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      channel: orders.channel,
      publicToken: orders.publicToken,
      shippingCents: orders.shippingCents,
      mpPreferenceId: orders.mpPreferenceId,
      customerId: orders.customerId,
      paymentMethod: orders.paymentMethod,
    })
    .from(orders)
    .where(eq(orders.id, parsed.orderId));

  if (!order) {
    throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
  }
  // Qualquer canal pode pagar online: pedidos manuais/WhatsApp recebem o
  // link público (/pedido/{token}) e pagam pelo mesmo botão da loja.
  if (order.status !== "pending_payment") {
    throw new ServiceError(
      "ORDER_NOT_PAYABLE",
      order.status === "paid"
        ? "Este pedido já está pago — não é preciso pagar de novo."
        : "Este pedido não está mais aguardando pagamento.",
    );
  }
  // Dinheiro na entrega nunca gera link do MP — a UI não mostra o botão, e
  // este guard cobre POST direto com o token (defesa em profundidade).
  // pix_manual segue permitido: o cliente ainda pode preferir pagar online.
  if (order.paymentMethod === "cash") {
    throw new ServiceError(
      "ORDER_NOT_PAYABLE",
      "Este pedido será pago em dinheiro na entrega — combine pelo WhatsApp.",
    );
  }

  const rows = await db
    .select({
      title: orderItems.nameSnapshot,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  if (rows.length === 0) {
    throw new ServiceError(
      "ORDER_WITHOUT_ITEMS",
      "Este pedido não tem itens para pagar.",
    );
  }

  const items: CheckoutPreferenceItem[] = rows.map((row) => ({
    title: row.title,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
  }));
  // Frete entra como item próprio: o total cobrado no MP TEM de bater com
  // orders.total_cents (itens + frete).
  if (order.shippingCents > 0) {
    items.push({ title: "Frete", quantity: 1, unitPriceCents: order.shippingCents });
  }

  const [customer] = await db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, order.customerId));

  const site = getSiteUrl();
  const preference = await gateway.createCheckoutPreference({
    orderId: order.id,
    orderNumber: order.orderNumber,
    externalReference: order.id,
    items,
    ...(customer?.email ? { payerEmail: customer.email } : {}),
    backUrl: `${site}/pedido/${order.publicToken}`,
    notificationUrl: `${site}/api/webhooks/mercadopago`,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ mpPreferenceId: preference.preferenceId, updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "order.mp_preference_created",
      entityType: "order",
      entityId: order.id,
      before: { mpPreferenceId: order.mpPreferenceId },
      after: { mpPreferenceId: preference.preferenceId },
    });
  });

  return {
    preferenceId: preference.preferenceId,
    initPointUrl: preference.initPointUrl,
  };
}

/**
 * Variante para a página pública /pedido/[token]: resolve o publicToken para
 * o orderId INTERNAMENTE — o id do pedido nunca é exposto ao cliente.
 */
export async function ensurePaymentPreferenceByToken(
  db: DbOrTx,
  gateway: StorePaymentGateway,
  input: { publicToken: string },
): Promise<EnsurePaymentPreferenceResult> {
  const token = z.uuid().safeParse(input.publicToken);
  if (!token.success) {
    throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
  }
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.publicToken, token.data));
  if (!order) {
    throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
  }
  return ensurePaymentPreference(db, gateway, { orderId: order.id });
}
