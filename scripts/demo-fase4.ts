// Roteiro E2E da Fase 4 (WhatsApp, modo simulado): mensagens do ciclo do
// pedido, avisos internos, teste de RESILIÊNCIA (sessão cai → fila segura →
// reconecta → entrega), comando SAIR e lembrete único de pagamento.
// Uso: ADAPTER_MODE=fake npx tsx --env-file=.env.local scripts/demo-fase4.ts
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { listPublicProducts, getPublicProductBySlug, quoteShipping, computeTotalWeightGrams } from "@/services/store-catalog";
import { createStoreOrder } from "@/services/store-orders";
import { transitionOrder, updateOrderTracking } from "@/services/orders";
import { processZapiInbound } from "@/services/wa-inbound";
import { recoverUnpaidOrders } from "@/services/wa-messaging";
import { getMessagingProvider } from "@/adapters/zapi";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { drainOutbox } from "@/queue/worker";

const OWNER_PHONE = "+5511900001111";
const CLIENT_PHONE = "11 96666-5555";

async function drainAll(db: ReturnType<typeof getDb>) {
  await db.execute(sql`update outbox_events set next_attempt_at = now() - interval '1 second' where status in ('pending','failed')`);
  return drainOutbox(db, { limit: 50 });
}

async function main() {
  const db = getDb();
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));
  const wa = getMessagingProvider();
  if (!(wa instanceof FakeMessagingProvider)) throw new Error("Rode com ADAPTER_MODE=fake");

  console.log("0) Liga o WhatsApp e cadastra o número do dono…");
  await db.execute(sql`update settings set value = 'true'::jsonb where key = 'wa_enabled'`);
  await db.execute(sql`update settings set value = ${JSON.stringify(OWNER_PHONE)}::jsonb where key = 'owner_whatsapp_phone'`);

  console.log("1) Cliente COM opt-in compra na loja…");
  const products = await listPublicProducts(db, {});
  const product = await getPublicProductBySlug(db, products[0].slug);
  const variant = product!.variants.find((v) => v.availableQty > 0)!;
  const weight = computeTotalWeightGrams([{ weightGrams: variant.weightGrams, quantity: 1 }]);
  const [freight] = await quoteShipping(db, { cep: "01310100", totalWeightGrams: weight });
  const order = await createStoreOrder(db, {
    customer: { fullName: "Zapeira da Silva", document: "39053344705", phone: CLIENT_PHONE, marketingOptIn: true },
    address: { postalCode: "01310100", street: "Avenida Paulista", number: "3000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId: variant.variantId, quantity: 1, expectedUnitPriceCents: variant.priceCents }],
    shippingRateId: freight.rateId,
    expectedShippingCents: freight.priceCents,
  });
  await drainAll(db);
  const afterCreate = wa.sentMessages.length;
  console.log(`   pedido #${order.orderNumber} → mensagens enviadas: ${afterCreate} (confirmação p/ cliente + aviso p/ dono)`);
  if (afterCreate < 2) throw new Error("Esperava confirmação + aviso interno");

  console.log("2) Dono marca pago → cliente e dono avisados…");
  await transitionOrder(db, { orderId: order.orderId, to: "paid", userId: owner.id });
  await drainAll(db);
  console.log(`   total agora: ${wa.sentMessages.length} mensagens`);

  console.log("3) TESTE DE RESILIÊNCIA: sessão cai; pedido é enviado nesse meio-tempo…");
  wa.simulateDisconnect();
  await updateOrderTracking(db, { orderId: order.orderId, trackingCode: "BR123456789ZZ", userId: owner.id });
  await transitionOrder(db, { orderId: order.orderId, to: "preparing", userId: owner.id });
  await transitionOrder(db, { orderId: order.orderId, to: "shipped", userId: owner.id });
  const drainDown = await drainAll(db);
  const failedWa = await db.select().from(schema.waMessages).where(eq(schema.waMessages.status, "failed"));
  console.log(`   com sessão caída: drain=${JSON.stringify(drainDown)}; mensagens presas na fila: ${failedWa.length}`);
  if (failedWa.length === 0) throw new Error("Esperava mensagem retida com a sessão caída");

  console.log("4) Sessão reconecta → fila entrega TUDO sem duplicar…");
  wa.simulateReconnect();
  const before = wa.sentMessages.length;
  await drainAll(db);
  const delivered = wa.sentMessages.length - before;
  const stillFailed = await db.select().from(schema.waMessages).where(eq(schema.waMessages.status, "failed"));
  console.log(`   entregues na reconexão: ${delivered}; presas restantes: ${stillFailed.length}`);
  if (delivered === 0 || stillFailed.length > 0) throw new Error("Reconexão não entregou a fila");
  const shippedMsg = wa.sentMessages.find((m) => m.body.includes("BR123456789ZZ"));
  console.log(`   rastreio no texto do cliente: ${shippedMsg ? "sim ✓" : "NÃO ✗"}`);

  console.log("5) Cliente responde SAIR → opt-out + confirmação educada…");
  const sair = await processZapiInbound(db, {
    providedSecret: process.env.ZAPI_WEBHOOK_SECRET ?? "",
    body: { phone: "5511966665555", messageId: `demo-sair-${order.orderNumber}`, text: { message: "SAIR" } },
  });
  await drainAll(db);
  const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.phoneE164, "+5511966665555"));
  console.log(`   ação=${sair.action}; opt-in do cliente agora: ${cust.marketingOptIn} (esperado false)`);
  if (cust.marketingOptIn !== false) throw new Error("SAIR não desligou o opt-in");

  console.log("6) Outro cliente responde texto → encaminhado ao dono…");
  await processZapiInbound(db, {
    providedSecret: process.env.ZAPI_WEBHOOK_SECRET ?? "",
    body: { phone: "5511955554444", messageId: `demo-fwd-${order.orderNumber}`, text: { message: "Oi! Tem tamanho G?" } },
  });
  await drainAll(db);
  const fwd = wa.sentMessages.filter((m) => m.toE164 === OWNER_PHONE && m.body.includes("Tem tamanho G"));
  console.log(`   dono recebeu o encaminhamento: ${fwd.length > 0 ? "sim ✓" : "NÃO ✗"}`);

  console.log("7) Lembrete ÚNICO de pagamento (pedido parado há 61min)…");
  const order2 = await createStoreOrder(db, {
    customer: { fullName: "Esquecida de Souza", document: "11144477735", phone: "11 94444-3333", marketingOptIn: true },
    address: { postalCode: "01310100", street: "Avenida Paulista", number: "4000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId: variant.variantId, quantity: 1, expectedUnitPriceCents: variant.priceCents }],
    shippingRateId: freight.rateId,
    expectedShippingCents: freight.priceCents,
  });
  await drainAll(db);
  await db.execute(sql`update orders set created_at = now() - interval '61 minutes', payment_due_at = now() + interval '59 minutes' where id = ${order2.orderId}`);
  const r1 = await recoverUnpaidOrders(db, wa);
  const r2 = await recoverUnpaidOrders(db, wa);
  console.log(`   1ª rodada: ${JSON.stringify(r1)}; 2ª rodada (não repete): enviadas=${r2.sent}`);
  if (r1.sent !== 1 || r2.sent !== 0) throw new Error("Recovery deveria enviar exatamente 1 vez");

  console.log("--- RESULTADO ---");
  console.log(`Mensagens WhatsApp enviadas no total (fake): ${wa.sentMessages.length}`);
  for (const m of wa.sentMessages.slice(0, 12)) {
    console.log(`  → ${m.toE164 === OWNER_PHONE ? "[DONO]" : "[cliente]"} ${m.body.split("\n")[0].slice(0, 70)}`);
  }
  console.log("DEMO FASE 4 OK — nada se perdeu com a sessão caída, SAIR respeitado, lembrete único.");
  process.exit(0);
}

main().catch((e) => {
  console.error("DEMO FALHOU:", e);
  process.exit(1);
});
