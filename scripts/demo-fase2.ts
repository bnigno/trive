// Roteiro E2E da Fase 2 (loja): compra completa como um cliente faria —
// cotação de frete → checkout com CPF → página pública → dono marca pago.
// Uso: npx tsx --env-file=.env.local scripts/demo-fase2.ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { listPublicProducts, getPublicProductBySlug, quoteShipping, computeTotalWeightGrams } from "@/services/store-catalog";
import { createStoreOrder, getPublicOrder, PriceChangedError } from "@/services/store-orders";
import { transitionOrder } from "@/services/orders";

async function main() {
  const db = getDb();
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));

  console.log("1) Cliente navega na vitrine…");
  let products = await listPublicProducts(db, {});
  if (products.length === 0) {
    // Como o dono faria no admin: ativa produtos de rascunho que já têm preço ativo.
    console.log("   vitrine vazia — ativando produtos de demonstração com preço definido…");
    await db.execute(
      `update products set status = 'active'
       where status = 'draft' and id in (
         select p.id from products p
         join product_variants v on v.product_id = p.id
         join price_versions pv on pv.product_variant_id = v.id and pv.status = 'active'
       )`,
    );
    products = await listPublicProducts(db, {});
  }
  if (products.length === 0) throw new Error("Vitrine vazia — rode scripts/demo-fase1.ts antes.");
  const product = await getPublicProductBySlug(db, products[0].slug);
  const variant = product!.variants.find((v) => v.availableQty > 0);
  if (!variant) throw new Error("Nenhuma variante com estoque.");
  console.log(`   escolheu: ${product!.name} (${variant.sku}) por ${formatCentsBRL(variant.priceCents)} — ${variant.availableQty} disponíveis`);

  console.log("2) Cota o frete para CEP 01310-100 (Av. Paulista)…");
  const weight = computeTotalWeightGrams([{ weightGrams: variant.weightGrams, quantity: 1 }]);
  const quotes = await quoteShipping(db, { cep: "01310100", totalWeightGrams: weight });
  if (quotes.length === 0) throw new Error("Nenhuma faixa de frete cobre o CEP.");
  const freight = quotes[0];
  console.log(`   opção: ${freight.name} ${formatCentsBRL(freight.priceCents)} (${freight.deliveryDaysMin}-${freight.deliveryDaysMax} dias)`);

  console.log("3) Fecha o pedido no checkout (CPF válido de teste)…");
  const result = await createStoreOrder(db, {
    customer: {
      fullName: "Maria Compradora da Silva",
      document: "52998224725",
      phone: "11 98888-7777",
      email: "maria.demo@exemplo.com.br",
      marketingOptIn: true,
    },
    address: {
      postalCode: "01310100",
      street: "Avenida Paulista",
      number: "1000",
      complement: "ap 42",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId: variant.variantId, quantity: 1, expectedUnitPriceCents: variant.priceCents }],
    shippingRateId: freight.rateId,
    expectedShippingCents: freight.priceCents,
  });
  console.log(`   pedido #${result.orderNumber} confirmado — total ${formatCentsBRL(result.totalCents)}, reserva até ${result.paymentDueAt?.toISOString()}`);

  console.log("4) Cliente abre a página pública (sem dados pessoais)…");
  const publicView = await getPublicOrder(db, result.publicToken);
  const keys = JSON.stringify(publicView);
  const leaked = ["Maria", "52998224725", "Paulista", "98888"].filter((s) => keys.includes(s));
  if (leaked.length > 0) throw new Error(`VAZAMENTO DE PII na página pública: ${leaked.join(", ")}`);
  console.log(`   status: ${publicView!.status} | itens: ${publicView!.items.length} | PII: nenhuma ✓`);

  console.log("5) Dono marca como pago no admin…");
  await transitionOrder(db, { orderId: result.orderId, to: "paid", userId: owner.id });
  const paidView = await getPublicOrder(db, result.publicToken);
  console.log(`   página pública agora mostra: ${paidView!.status} ✓`);

  console.log("6) Teste de mudança de preço (CDC): cliente com preço velho…");
  try {
    await createStoreOrder(db, {
      customer: { fullName: "Outro Cliente Teste", document: "52998224725", phone: "11 98888-7777", marketingOptIn: false },
      address: { postalCode: "01310100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
      items: [{ variantId: variant.variantId, quantity: 1, expectedUnitPriceCents: variant.priceCents - 1000 }],
      shippingRateId: freight.rateId,
      expectedShippingCents: freight.priceCents,
    });
    throw new Error("Deveria ter detectado preço divergente!");
  } catch (e) {
    if (e instanceof PriceChangedError) {
      console.log(`   PriceChangedError detectado corretamente: ${e.changes.length} item(ns) divergente(s) ✓`);
    } else throw e;
  }

  console.log("DEMO FASE 2 OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("DEMO FALHOU:", e);
  process.exit(1);
});
