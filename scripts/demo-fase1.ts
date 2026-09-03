// Roteiro demonstrável da Fase 1, executado de ponta a ponta contra o banco:
// produto → estoque → preço (aprovação) → pedido → pago, imprimindo cada passo.
// Uso: npx tsx --env-file=.env.local scripts/demo-fase1.ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { createCategory, createProduct } from "@/services/catalog";
import { receiveStock, getStockOverview } from "@/services/stock";
import { createPriceVersion, approvePriceVersion, getActivePrice } from "@/services/pricing";
import { createCustomer } from "@/services/customers";
import { createManualOrder, transitionOrder, getOrderDetail } from "@/services/orders";

async function main() {
  const db = getDb();
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));
  if (!owner) throw new Error("Nenhum usuário owner encontrado — rode scripts/create-admin.ts antes.");
  const userId = owner.id;
  const stamp = Date.now().toString(36).toUpperCase();

  console.log("1) Categoria e produto com 2 variações…");
  const category = await createCategory(db, { name: `Demonstração ${stamp}`, userId });
  const product = await createProduct(db, {
    name: `Camiseta TRIVÉ ${stamp}`,
    description: "Produto de demonstração da Fase 1.",
    categoryId: category.id,
    attributesSchema: ["tamanho"],
    variants: [
      { sku: `CAM-${stamp}-M`, attributes: { tamanho: "M" }, costCents: 4000 },
      { sku: `CAM-${stamp}-G`, attributes: { tamanho: "G" }, costCents: 4000 },
    ],
    userId,
  });
  const detail = product.variants;
  const variantM = detail[0];
  console.log(`   produto ${product.product.id} com ${detail.length} variações`);

  console.log("2) Entrada de estoque: 10 unidades de cada…");
  for (const v of detail) {
    await receiveStock(db, { variantId: v.id, quantity: 10, unitCostCents: 4000, note: "Compra inicial (demo)", userId });
  }

  console.log("3) Precificação (primeira exige aprovação)…");
  const version = await createPriceVersion(db, { variantId: variantM.id, userId, origin: "initial" });
  console.log(`   versão v${version.versionNumber} status=${version.status} preço=${formatCentsBRL(version.priceCents)} motivos=${version.approvalReasons?.join(",") || "-"}`);
  if (version.status === "pending_approval") {
    await approvePriceVersion(db, { versionId: version.id, userId });
    console.log("   aprovada e ativada pelo dono ✓");
  }
  const active = await getActivePrice(db, variantM.id);
  console.log(`   preço ativo: ${formatCentsBRL(active!.priceCents)} margem ${(Number(active!.computedMarginRate) * 100).toFixed(2)}%`);

  console.log("4) Cliente e pedido manual (2 unidades)…");
  const customerId = await createCustomer(db, {
    fullName: `Cliente Demonstração ${stamp}`,
    phone: `11 9${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
    marketingOptIn: true,
    userId,
  }).then((c: { id?: string } | string) => (typeof c === "string" ? c : c.id!));
  const order = await createManualOrder(db, {
    customerId,
    items: [{ variantId: variantM.id, quantity: 2 }],
    shippingCents: 1500,
    note: "Pedido de demonstração",
    userId,
  });
  console.log(`   pedido #${order.orderNumber} criado (rascunho)`);

  console.log("5) Confirmar (reserva estoque) e marcar pago (baixa + financeiro)…");
  await transitionOrder(db, { orderId: order.orderId, to: "pending_payment", userId });
  await transitionOrder(db, { orderId: order.orderId, to: "paid", userId });

  const final = await getOrderDetail(db, order.orderId);
  if (!final) throw new Error("Pedido sumiu?");
  const overview = await getStockOverview(db);
  const level = overview.find((r) => r.variantId === variantM.id);
  const entries = await db.select().from(schema.financialEntries).where(eq(schema.financialEntries.orderId, order.orderId));

  console.log("--- RESULTADO ---");
  console.log(`Pedido #${final.orderNumber}: status=${final.status} total=${formatCentsBRL(final.totalCents)}`);
  console.log(`Estoque ${variantM.sku ?? "M"}: físico=${level?.onHand} reservado=${level?.reserved} disponível=${level?.available}`);
  console.log(`Financeiro: ${entries.length} lançamento(s) — ${entries.map((e) => `${e.category} ${formatCentsBRL(e.amountCents)} ${e.status}`).join("; ")}`);
  const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.productVariantId, variantM.id));
  console.log(`Ledger de estoque: ${movements.length} movimentos (${movements.map((m) => m.type).join(", ")})`);
  console.log("DEMO OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("DEMO FALHOU:", e);
  process.exit(1);
});
