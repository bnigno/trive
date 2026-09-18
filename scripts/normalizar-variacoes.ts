// Põe cor/tamanho das variações já gravadas no padrão do catálogo
// (normalizeAxisValue: "RAJADO" → "Rajado", "m" → "M"). Até a correção de
// 18/09/2026 os formulários "Adicionar/Editar variação" gravavam o texto
// cru, e a foto marcada por cor não achava a variação. Simulação por padrão;
// --apply regrava pelo updateVariant (auditoria + refresh do cartão da Lia).
// Duas variações do mesmo produto que normalizam igual colidem no UNIQUE
// (product_id, attributes): o script avisa e a dona resolve no painel.
// Uso: npx tsx --env-file=.env.prod.local scripts/normalizar-variacoes.ts [--apply]
import { eq, isNull } from "drizzle-orm";

import { normalizeAxisValue } from "@/core/catalog/attributes";
import { getDb } from "@/db/client";
import { productVariants, products, users } from "@/db/schema";
import { updateVariant } from "@/services/catalog";

function normalized(attributes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [axis, value] of Object.entries(attributes)) {
    const v = normalizeAxisValue(value ?? "");
    if (v) out[axis] = v;
  }
  return out;
}

const stable = (attributes: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : 1))));
const show = (attributes: Record<string, string>) => Object.entries(attributes).map(([k, v]) => `${k}: ${v}`).join(" · ") || "(sem atributos)";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const [owner] = await db.select({ id: users.id, name: users.fullName }).from(users).where(eq(users.role, "owner")).limit(1);
  if (!owner) throw new Error("Nenhum usuário owner para assinar a auditoria.");

  const rows = await db
    .select({ id: productVariants.id, sku: productVariants.sku, attributes: productVariants.attributes, productId: productVariants.productId, productName: products.name })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(isNull(productVariants.deletedAt))
    .orderBy(products.name, productVariants.sku);

  const targetByProduct = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const key = stable(normalized((row.attributes ?? {}) as Record<string, string>));
    const byKey = targetByProduct.get(row.productId) ?? new Map<string, string[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), row.sku]);
    targetByProduct.set(row.productId, byKey);
  }

  let changed = 0;
  let collisions = 0;
  let failed = 0;
  const tag = apply ? "" : " (simulação)";
  for (const row of rows) {
    const current = (row.attributes ?? {}) as Record<string, string>;
    const target = normalized(current);
    if (stable(current) === stable(target)) continue;
    const siblings = targetByProduct.get(row.productId)?.get(stable(target)) ?? [];
    if (siblings.length > 1) {
      collisions += 1;
      console.log(`COLISÃO ${row.productName} — ${row.sku}: ${show(current)} → ${show(target)} bate com ${siblings.filter((s) => s !== row.sku).join(", ")}. Junte ou apague uma delas no painel; nada feito.`);
      continue;
    }
    console.log(`${row.productName} — ${row.sku}: ${show(current)} → ${show(target)}${tag}`);
    if (apply) {
      try {
        await updateVariant(db, { variantId: row.id, attributes: current, userId: owner.id });
      } catch (error) {
        failed += 1;
        console.error(`  falhou: ${error instanceof Error ? error.message : error}`);
        continue;
      }
    }
    changed += 1;
  }
  console.log(
    changed === 0 && collisions === 0
      ? "Nada a fazer: todas as variações já estão no padrão."
      : `${changed} variação(ões) ${apply ? "regravada(s)" : "a regravar"}${collisions ? `, ${collisions} colisão(ões) para resolver no painel` : ""}${failed ? `, ${failed} falhou(aram)` : ""}.${apply ? ` Auditoria: ${owner.name ?? owner.id}.` : " Rode com --apply para gravar."}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
