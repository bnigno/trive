// Roteiro E2E da Fase 3 (pagamento automático, modo simulado):
// pedido da loja → preference MP → webhook de pagamento → fila processa →
// pedido pago sozinho, taxa real gravada, e-mails disparados.
// Uso: ADAPTER_MODE=fake npx tsx --env-file=.env.local scripts/demo-fase3.ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { listPublicProducts, getPublicProductBySlug, quoteShipping, computeTotalWeightGrams } from "@/services/store-catalog";
import { createStoreOrder } from "@/services/store-orders";
import { ensurePaymentPreference } from "@/services/store-payments";
import { updateSetting } from "@/services/settings";
import { processInboundMpWebhook } from "@/services/webhooks";
import { getPaymentGateway } from "@/adapters/mercadopago";
import { FakePaymentGateway } from "@/adapters/mercadopago/fake";
import { getEmailProvider } from "@/adapters/email";
import { FakeEmailProvider } from "@/adapters/email/fake";
import { drainOutbox } from "@/queue/worker";

async function main() {
  const db = getDb();
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));
  const gateway = getPaymentGateway();
  if (!(gateway instanceof FakePaymentGateway)) throw new Error("Rode com ADAPTER_MODE=fake");

  console.log("0) Liga o Mercado Pago (setting mp_enabled)…");
  await updateSetting(db, { key: "mp_enabled", value: true, userId: owner.id });

  console.log("1) Cliente compra na loja…");
  const products = await listPublicProducts(db, {});
  const product = await getPublicProductBySlug(db, products[0].slug);
  const variant = product!.variants.find((v) => v.availableQty > 0)!;
  const weight = computeTotalWeightGrams([{ weightGrams: variant.weightGrams, quantity: 1 }]);
  const [freight] = await quoteShipping(db, { cep: "01310100", totalWeightGrams: weight });
  const order = await createStoreOrder(db, {
    customer: { fullName: "Pagador Automático da Silva", document: "52998224725", phone: "11 97777-6666", email: "pagador.demo@exemplo.com.br", marketingOptIn: true },
    address: { postalCode: "01310100", street: "Avenida Paulista", number: "2000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId: variant.variantId, quantity: 1, expectedUnitPriceCents: variant.priceCents }],
    shippingRateId: freight.rateId,
    expectedShippingCents: freight.priceCents,
  });
  console.log(`   pedido #${order.orderNumber} aguardando pagamento (${formatCentsBRL(order.totalCents)})`);

  console.log("2) Checkout Pro: preference criada…");
  const pref = await ensurePaymentPreference(db, gateway, { orderId: order.orderId });
  console.log(`   preference ${pref.preferenceId} → initPoint ${pref.initPointUrl}`);

  console.log("3) Cliente paga (simulado) e o MP manda o webhook…");
  const paymentId = gateway.paymentIdForPreference(pref.preferenceId)!;
  gateway.approvePayment(paymentId);
  const webhook = await processInboundMpWebhook(db, {
    xSignature: null,
    xRequestId: "demo-req-1",
    body: { type: "payment", data: { id: paymentId } },
  });
  console.log(`   webhook aceito (duplicado=${"duplicate" in webhook ? webhook.duplicate : false}); evento na fila`);

  const dup = await processInboundMpWebhook(db, {
    xSignature: null,
    xRequestId: "demo-req-1",
    body: { type: "payment", data: { id: paymentId } },
  });
  console.log(`   reenvio do MP (idempotência): duplicate=${dup.duplicate === true}`);

  console.log("4) Fila processa (varredura)…");
  const drained = await drainOutbox(db, { limit: 20 });
  console.log(`   worker: ${JSON.stringify(drained)}`);

  const [finalOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
  const entries = await db.select().from(schema.financialEntries).where(eq(schema.financialEntries.orderId, order.orderId));
  const emails = getEmailProvider();
  const sent = emails instanceof FakeEmailProvider ? emails.sentEmails : [];

  console.log("--- RESULTADO ---");
  console.log(`Pedido #${finalOrder.orderNumber}: status=${finalOrder.status} | método=${finalOrder.paymentMethod} | mpPaymentId=${finalOrder.mpPaymentId}`);
  console.log(`Taxa real do MP: ${finalOrder.mpFeeCents != null ? formatCentsBRL(finalOrder.mpFeeCents) : "—"} sobre ${formatCentsBRL(finalOrder.totalCents)}`);
  console.log(`Financeiro: ${entries.map((e) => `${e.category} ${formatCentsBRL(e.amountCents)} ${e.status}`).join("; ") || "nenhum"}`);
  console.log(`E-mails enviados (fake): ${sent.length} — ${sent.map((e) => e.subject).join(" | ")}`);
  if (finalOrder.status !== "paid") throw new Error("Pedido não foi pago automaticamente!");
  if (sent.length === 0) throw new Error("Nenhum e-mail disparado!");
  console.log("DEMO FASE 3 OK — pagamento confirmado sem toque humano.");
  process.exit(0);
}

main().catch((e) => {
  console.error("DEMO FALHOU:", e);
  process.exit(1);
});
