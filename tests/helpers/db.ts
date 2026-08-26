// Banco Postgres REAL em memória (PGlite) para testes de integração:
// aplica as migrações de drizzle/ (incluindo triggers) e oferece fixtures mínimas.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export const FIXED_USER_ID = "00000000-0000-4000-8000-000000000001";

// Migrar é caro (~1,3s); fazemos UMA vez por worker e clonamos o data dir
// para cada teste (~100ms), mantendo isolamento total entre testes.
let templatePromise: Promise<Blob | File> | null = null;

function getMigratedTemplate(): Promise<Blob | File> {
  templatePromise ??= (async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    const dump = await client.dumpDataDir();
    await client.close();
    return dump;
  })();
  return templatePromise;
}

export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = new PGlite({ loadDataDir: await getMigratedTemplate() });
  const db = drizzle(client, { schema });

  await db.insert(schema.users).values({
    id: FIXED_USER_ID,
    email: "teste@trive.local",
    fullName: "Testador",
    role: "owner",
  });
  await db.insert(schema.settings).values([
    { key: "price_change_pct_threshold", value: 0.1 },
    { key: "first_price_requires_approval", value: true },
    { key: "default_low_stock_threshold", value: 3 },
    { key: "stock_reservation_ttl_minutes", value: 120 },
  ]);

  return { db, close: () => client.close() };
}

export async function createTestFeeRuleAndPolicy(db: TestDb): Promise<{ feeRuleId: string; policyId: string }> {
  const [feeRule] = await db
    .insert(schema.paymentFeeRules)
    .values({
      paymentMethod: "credit_card",
      installmentsMax: 12,
      percentRate: "0.0498",
      fixedFeeCents: 0,
      settlementDays: 30,
      isReferenceForPricing: true,
    })
    .returning({ id: schema.paymentFeeRules.id });
  const [policy] = await db
    .insert(schema.pricingPolicies)
    .values({
      name: "default",
      scopeType: "global",
      targetMarginRate: "0.3000",
      minMarginRate: "0.1500",
      roundingMode: "to_90",
      roundingDirection: "up",
      isActive: true,
    })
    .returning({ id: schema.pricingPolicies.id });
  return { feeRuleId: feeRule.id, policyId: policy.id };
}

export async function createTestVariant(
  db: TestDb,
  opts: { sku?: string; costCents?: number; onHand?: number; name?: string } = {},
): Promise<{ productId: string; variantId: string }> {
  const sku = opts.sku ?? `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const name = opts.name ?? `Produto ${sku}`;
  const [product] = await db
    .insert(schema.products)
    .values({ name, slug: sku.toLowerCase(), status: "active" })
    .returning({ id: schema.products.id });
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product.id, sku, costCents: opts.costCents ?? 1000 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({
    productVariantId: variant.id,
    onHand: opts.onHand ?? 0,
    reserved: 0,
  });
  return { productId: product.id, variantId: variant.id };
}

export async function createTestSupplier(
  db: TestDb,
  opts: { name?: string; email?: string; phoneE164?: string; pixKey?: string } = {},
): Promise<string> {
  const [supplier] = await db
    .insert(schema.suppliers)
    .values({
      name: opts.name ?? "Fornecedor Teste",
      email: opts.email ?? null,
      phoneE164: opts.phoneE164 ?? null,
      pixKey: opts.pixKey ?? null,
    })
    .returning({ id: schema.suppliers.id });
  return supplier.id;
}

export async function createTestCustomer(db: TestDb, name = "Cliente Teste"): Promise<string> {
  const [customer] = await db
    .insert(schema.customers)
    .values({ fullName: name, phoneE164: `+55119${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}` })
    .returning({ id: schema.customers.id });
  return customer.id;
}
