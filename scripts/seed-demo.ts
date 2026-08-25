// Seed de DEMONSTRAÇÃO: produtos com foto gerada, estoque, preços (2 ficam
// pendentes de aprovação de propósito), clientes com CPF válido e um cupom.
// Tudo marcado com SKU 'DEMO-' e nota 'seed-demo' — scripts/seed-demo-clean.ts
// arquiva/oculta depois. Uso: ADAPTER_MODE=real npx tsx --env-file=.env.prod.local scripts/seed-demo.ts
import sharp from "sharp";
import { eq, like } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { getFileStorage } from "@/adapters/storage";
import { createCategory, createProduct, updateProduct, addProductImage } from "@/services/catalog";
import { receiveStock } from "@/services/stock";
import { createPriceVersion, approvePriceVersion } from "@/services/pricing";
import { createCustomer } from "@/services/customers";
import { createCoupon } from "@/services/coupons";
import { formatCentsBRL } from "@/lib/money";

function validCpf(seed: number): string {
  const d: number[] = [];
  let s = seed;
  for (let i = 0; i < 9; i++) { d.push(s % 10); s = Math.floor(s / 7) + i * 3 + 1; }
  if (d.every((x) => x === d[0])) d[8] = (d[8] + 1) % 10;
  const dv = (nums: number[]) => {
    const sum = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  d.push(dv(d)); d.push(dv(d));
  return d.join("");
}

async function productImage(name: string, hueA: string, hueB: string): Promise<Buffer> {
  const initials = name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hueA}"/><stop offset="1" stop-color="${hueB}"/>
    </linearGradient></defs>
    <rect width="1200" height="1200" fill="url(#g)"/>
    <circle cx="600" cy="560" r="330" fill="rgba(255,255,255,0.16)"/>
    <text x="600" y="640" font-family="Georgia, serif" font-size="280" fill="rgba(255,255,255,0.92)" text-anchor="middle" font-weight="bold">${initials}</text>
    <text x="600" y="1090" font-family="Helvetica, Arial" font-size="64" fill="rgba(255,255,255,0.85)" text-anchor="middle" letter-spacing="8">T R I V Ë</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const PRODUCTS: {
  name: string; brand?: string; description: string; category: string;
  hues: [string, string]; axes?: string[]; weightGrams: number; costCents: number;
  variants: { suffix: string; attributes: Record<string, string>; stock: number }[];
  skipPrice?: boolean;
}[] = [
  { name: "Camiseta Essencial", description: "Algodão penteado, caimento perfeito para o dia a dia.", category: "Vestuário", hues: ["#1c1917", "#57534e"], axes: ["cor", "tamanho"], weightGrams: 180, costCents: 2800,
    variants: [
      { suffix: "PRETA-M", attributes: { cor: "Preta", tamanho: "M" }, stock: 12 },
      { suffix: "PRETA-G", attributes: { cor: "Preta", tamanho: "G" }, stock: 9 },
      { suffix: "BRANCA-M", attributes: { cor: "Branca", tamanho: "M" }, stock: 10 },
      { suffix: "BRANCA-G", attributes: { cor: "Branca", tamanho: "G" }, stock: 7 },
    ] },
  { name: "Moletom Canguru", description: "Felpado por dentro, quentinho de verdade.", category: "Vestuário", hues: ["#7c2d12", "#c2410c"], axes: ["tamanho"], weightGrams: 550, costCents: 5500,
    variants: [
      { suffix: "M", attributes: { tamanho: "M" }, stock: 6 },
      { suffix: "G", attributes: { tamanho: "G" }, stock: 5 },
    ] },
  { name: "Caneca de Cerâmica", description: "330ml, própria para micro-ondas e lava-louças.", category: "Casa", hues: ["#0c4a6e", "#0284c7"], weightGrams: 420, costCents: 1200,
    variants: [{ suffix: "UNICA", attributes: {}, stock: 20 }] },
  { name: "Garrafa Térmica 500ml", description: "Mantém a temperatura por até 12 horas.", category: "Casa", hues: ["#14532d", "#16a34a"], weightGrams: 380, costCents: 3500,
    variants: [{ suffix: "UNICA", attributes: {}, stock: 8 }] },
  { name: "Bolsa Tote de Algodão", description: "Resistente, estampa exclusiva, fecho com botão.", category: "Acessórios", hues: ["#701a75", "#c026d3"], weightGrams: 240, costCents: 2200,
    variants: [{ suffix: "UNICA", attributes: {}, stock: 15 }] },
  { name: "Boné Bordado", description: "Aba curva, ajuste traseiro, bordado em alto relevo.", category: "Acessórios", hues: ["#713f12", "#ca8a04"], weightGrams: 120, costCents: 1800,
    variants: [{ suffix: "UNICO", attributes: {}, stock: 11 }] },
  { name: "Kit de Adesivos", description: "12 adesivos em vinil resistente à água.", category: "Acessórios", hues: ["#831843", "#ec4899"], weightGrams: 40, costCents: 400,
    variants: [{ suffix: "KIT", attributes: {}, stock: 2 }] }, // estoque baixo de propósito
  { name: "Meia Cano Alto", description: "Par em algodão com punho reforçado.", category: "Vestuário", hues: ["#312e81", "#6366f1"], weightGrams: 90, costCents: 800, skipPrice: true,
    variants: [{ suffix: "PAR", attributes: {}, stock: 30 }] }, // SEM preço: teste da calculadora
];

const CUSTOMERS = [
  { fullName: "Ana Beatriz Carvalho", seed: 12345, phone: "11 98811-2233", email: "ana.demo@exemplo.com.br", optIn: true, city: "São Paulo", state: "SP", cep: "01310100", street: "Avenida Paulista", number: "1578" },
  { fullName: "Bruno Ferreira Lima", seed: 22345, phone: "21 97722-3344", email: "bruno.demo@exemplo.com.br", optIn: true, city: "Rio de Janeiro", state: "RJ", cep: "22041011", street: "Rua Bolívar", number: "21" },
  { fullName: "Carla Mendes Rocha", seed: 32345, phone: "31 96633-4455", email: null, optIn: false, city: "Belo Horizonte", state: "MG", cep: "30130010", street: "Praça Sete de Setembro", number: "100" },
  { fullName: "Diego Santana Alves", seed: 42345, phone: "41 95544-5566", email: "diego.demo@exemplo.com.br", optIn: true, city: "Curitiba", state: "PR", cep: "80010000", street: "Rua XV de Novembro", number: "700" },
  { fullName: "Elisa Prado Nogueira", seed: 52345, phone: "51 94455-6677", email: "elisa.demo@exemplo.com.br", optIn: false, city: "Porto Alegre", state: "RS", cep: "90010150", street: "Rua dos Andradas", number: "1234" },
];

async function main() {
  const db = getDb();
  const storage = getFileStorage();
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));
  if (!owner) throw new Error("Nenhum owner encontrado.");
  const userId = owner.id;

  const existing = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(like(schema.productVariants.sku, "DEMO-%")).limit(1);
  if (existing.length > 0) {
    console.log("Seed de demonstração já existe (SKUs DEMO-*). Nada a fazer — rode scripts/seed-demo-clean.ts antes, se quiser recriar.");
    process.exit(0);
  }

  console.log("1) Categorias…");
  const categories = new Map<string, string>();
  for (const name of ["Vestuário", "Casa", "Acessórios"]) {
    try {
      const c = await createCategory(db, { name, userId });
      categories.set(name, c.id);
    } catch {
      const [row] = await db.select().from(schema.categories).where(eq(schema.categories.name, name));
      if (row) categories.set(name, row.id);
    }
  }

  console.log("2) Produtos, fotos, estoque e preços…");
  const pendingDemos: string[] = [];
  let productCount = 0;
  for (const p of PRODUCTS) {
    const created = await createProduct(db, {
      name: p.name,
      description: p.description,
      brand: "TRIVË",
      categoryId: categories.get(p.category),
      attributesSchema: p.axes ?? [],
      variants: p.variants.map((v) => ({
        sku: `DEMO-${p.name.split(" ")[0].toUpperCase().normalize("NFD").replace(/[^A-Z]/g, "")}-${v.suffix}`,
        attributes: v.attributes,
        costCents: p.costCents,
        weightGrams: p.weightGrams,
      })),
      userId,
    });
    const productId = created.product.id;

    const img = await productImage(p.name, p.hues[0], p.hues[1]);
    await addProductImage(db, storage, { productId, data: img, contentType: "image/png", altText: p.name, userId });

    for (let i = 0; i < created.variants.length; i++) {
      const variant = created.variants[i];
      await receiveStock(db, { variantId: variant.id, quantity: p.variants[i].stock, unitCostCents: p.costCents, note: "Estoque inicial (seed-demo)", userId });
      if (!p.skipPrice) {
        const version = await createPriceVersion(db, { variantId: variant.id, userId, origin: "initial" });
        if (version.status === "pending_approval") await approvePriceVersion(db, { versionId: version.id, userId });
      }
    }
    await updateProduct(db, { productId, status: "active", userId });
    productCount++;
    console.log(`   ✓ ${p.name} (${created.variants.length} variação(ões))${p.skipPrice ? " — SEM preço (teste da calculadora)" : ""}`);
  }

  console.log("3) Deixando 2 reduções de preço PENDENTES (para você testar a aprovação)…");
  const demoVariants = await db.select().from(schema.productVariants).where(like(schema.productVariants.sku, "DEMO-CAMISETA-%")).limit(2);
  for (const v of demoVariants) {
    const [active] = await db.select().from(schema.priceVersions)
      .where(eq(schema.priceVersions.productVariantId, v.id))
      .then((rows) => rows.filter((r) => r.status === "active"));
    if (!active) continue;
    const pending = await createPriceVersion(db, {
      variantId: v.id, userId, origin: "manual",
      priceCentsManual: Math.max(100, active.priceCents - 1500),
    });
    pendingDemos.push(`${v.sku}: ${formatCentsBRL(active.priceCents)} → ${formatCentsBRL(pending.priceCents)} (${pending.status})`);
  }

  console.log("4) Clientes…");
  for (const c of CUSTOMERS) {
    await createCustomer(db, {
      fullName: c.fullName,
      document: validCpf(c.seed),
      phone: c.phone,
      email: c.email ?? undefined,
      marketingOptIn: c.optIn,
      notes: "seed-demo",
      address: { postalCode: c.cep, street: c.street, number: c.number, district: "Centro", city: c.city, state: c.state },
      userId,
    });
    console.log(`   ✓ ${c.fullName} (${c.city}/${c.state}${c.optIn ? ", opt-in WhatsApp" : ""})`);
  }

  console.log("5) Cupom de boas-vindas…");
  await createCoupon(db, { code: "BEMVINDO10", type: "percent", value: 10, minOrderCents: 5000, userId });

  console.log("\n--- PRONTO PARA TESTAR ---");
  console.log(`Produtos: ${productCount} (1 sem preço, 1 com estoque baixo) | Clientes: ${CUSTOMERS.length} | Cupom: BEMVINDO10 (10% acima de R$ 50)`);
  console.log("Aprovações pendentes:", pendingDemos.length ? pendingDemos.join(" | ") : "nenhuma");
  process.exit(0);
}

main().catch((e) => { console.error("SEED FALHOU:", e); process.exit(1); });
