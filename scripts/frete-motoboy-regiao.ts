// Ajeita as faixas de frete da região de Belém por motoboy (decisão da
// dona, 2026-09-17). Trabalha por CIDADE → faixa oficial de CEP, não por
// nome: a faixa que já cobre a cidade (de qualquer tipo, ex.: "Belém" como
// Correios) vira motoboy com a faixa oficial, as janelas e o nome padrão —
// preço e peso da dona ficam; cidade sem faixa nasce com o molde da
// primeira; a Correios "para todo o Brasil" ativa é desligada (fora da
// região o frete é calculado pela equipe — sob consulta = inativa). A lógica
// mora em core/shipping/motoboy-region.ts (pura, testada). Simulação por
// padrão; só grava com --apply, com a auditoria no nome do dono.
// Uso: npx tsx --env-file=.env.prod.local scripts/frete-motoboy-regiao.ts [--apply]
import { eq } from "drizzle-orm";

import { planMotoboyRegion, type RateTarget } from "@/core/shipping/motoboy-region";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { createShippingRate, listShippingRates, updateShippingRate, type ShippingRate } from "@/services/shipping";

function describe(target: RateTarget): string {
  return `${target.cepStart}–${target.cepEnd}, R$ ${(target.priceCents / 100).toFixed(2)}, ${target.weightMinGrams}–${target.weightMaxGrams} g, janelas ${target.deliveryWindows.map((w) => `${w.start}–${w.end} (até ${w.cutoff})`).join(", ")}`;
}

function fieldsOf(rate: ShippingRate) {
  return {
    name: rate.name,
    cepStart: rate.cepStart,
    cepEnd: rate.cepEnd,
    weightMinGrams: rate.weightMinGrams,
    weightMaxGrams: rate.weightMaxGrams,
    priceCents: rate.priceCents,
    deliveryDaysMin: rate.deliveryDaysMin,
    deliveryDaysMax: rate.deliveryDaysMax,
    kind: rate.kind,
    deliveryWindows: rate.deliveryWindows,
    isActive: rate.isActive,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const [owner] = await db.select({ id: users.id, name: users.fullName }).from(users).where(eq(users.role, "owner")).limit(1);
  if (!owner) throw new Error("Nenhum usuário owner para assinar a auditoria.");

  const rates = await listShippingRates(db);
  const byId = new Map(rates.map((rate) => [rate.id, rate]));
  const plan = planMotoboyRegion(rates);
  const tag = apply ? "" : " (simulação)";

  for (const keep of plan.keep) console.log(`${keep.city.name}: já certa (${keep.rate.cepStart}–${keep.rate.cepEnd}, motoboy, ${keep.rate.deliveryWindows.length} janelas).`);
  for (const item of plan.convert) {
    console.log(`"${item.rate.name}" → ${item.to.name}${tag}: ${item.changes.join("; ")}. Fica: ${describe(item.to)}`);
    if (apply) {
      await updateShippingRate(db, { ...fieldsOf(byId.get(item.rate.id)!), id: item.rate.id, ...item.to, deliveryWindows: [...item.to.deliveryWindows], deliveryDaysMin: 0, deliveryDaysMax: 0, isActive: true, userId: owner.id });
    }
  }
  for (const target of plan.create) {
    console.log(`${target.name}: criar${tag} — ${describe(target)}`);
    if (apply) {
      await createShippingRate(db, { ...target, deliveryWindows: [...target.deliveryWindows], deliveryDaysMin: 0, deliveryDaysMax: 0, userId: owner.id });
    }
  }
  for (const rate of plan.deactivate) {
    console.log(`"${rate.name}": desligar${tag} — fora da região o frete é calculado pela equipe (sob consulta = faixa inativa; ativa, a cliente pagaria R$ ${(rate.priceCents / 100).toFixed(2)} fixos).`);
    if (apply) {
      await updateShippingRate(db, { ...fieldsOf(byId.get(rate.id)!), id: rate.id, isActive: false, userId: owner.id });
    }
  }
  for (const warning of plan.warnings) console.log(`AVISO: ${warning}`);
  const nationwideOff = rates.filter((rate) => !rate.isActive && rate.cepStart === "00000000" && rate.cepEnd === "99999999" && rate.kind === "correios");
  for (const rate of nationwideOff) console.log(`"${rate.name}" continua inativa de propósito: é o que faz o resto do Brasil ser "Correios, frete calculado pela equipe".`);
  if (plan.convert.length === 0 && plan.create.length === 0 && plan.deactivate.length === 0) console.log("Nada a fazer: a região já está certa.");
  console.log(apply ? `Gravado (auditoria: ${owner.name ?? owner.id}).` : "Simulação — rode com --apply para gravar.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
