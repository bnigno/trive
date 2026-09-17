// Faixas de frete da região de Belém por motoboy (decisão da dona,
// 2026-09-17): Belém (com Icoaraci, Outeiro e Mosqueiro — CEP 66),
// Ananindeua, Marituba, Benevides, Santa Bárbara, Santa Izabel e Castanhal,
// todas por motoboy com o mesmo preço e as mesmas janelas da faixa "Motoboy
// Belém" que já existe; e a faixa de Correios "para todo o Brasil" desligada
// (fora da área o frete é calculado pela equipe). Idempotente: cria só o que
// falta (pelo nome) e mostra o que faria. Só grava com --apply, com a
// auditoria no nome do dono (primeiro usuário owner).
// Uso: DATABASE_URL=… npx tsx scripts/frete-motoboy-regiao.ts [--apply]
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { createShippingRate, listShippingRates, updateShippingRate } from "@/services/shipping";

/** Faixas oficiais dos Correios por município (as extremidades cobrem o município inteiro). */
const MOTOBOY_CITIES: { name: string; cepStart: string; cepEnd: string }[] = [
  { name: "Motoboy Belém", cepStart: "66000000", cepEnd: "66999999" },
  { name: "Motoboy Ananindeua", cepStart: "67000000", cepEnd: "67199999" },
  { name: "Motoboy Marituba", cepStart: "67200000", cepEnd: "67299999" },
  { name: "Motoboy Castanhal", cepStart: "68740000", cepEnd: "68749999" },
  { name: "Motoboy Santa Izabel", cepStart: "68790000", cepEnd: "68794999" },
  { name: "Motoboy Benevides", cepStart: "68795000", cepEnd: "68797999" },
  { name: "Motoboy Santa Bárbara", cepStart: "68798000", cepEnd: "68798999" },
];
const CORREIOS_TO_DISABLE = "Entrega padrão (todo o Brasil)";
const FALLBACK_PRICE_CENTS = 1500;
const FALLBACK_WINDOWS = [
  { start: "09:00", end: "12:00", cutoff: "08:00" },
  { start: "16:00", end: "19:00", cutoff: "13:00" },
  { start: "19:00", end: "21:00", cutoff: "17:00" },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const [owner] = await db.select({ id: users.id, name: users.fullName }).from(users).where(eq(users.role, "owner")).limit(1);
  if (!owner) throw new Error("Nenhum usuário owner para assinar a auditoria.");

  const rates = await listShippingRates(db);
  // Nome repetido (o painel não impede): vale a faixa ativa, e o aviso sai para a dona conferir.
  const byName = new Map<string, (typeof rates)[number]>();
  for (const rate of rates) {
    const key = rate.name.trim().toLowerCase();
    const seen = byName.get(key);
    if (seen) console.log(`AVISO: duas faixas chamadas "${rate.name}" (${seen.isActive ? "ativa" : "inativa"} e ${rate.isActive ? "ativa" : "inativa"}) — confira no painel.`);
    if (!seen || (!seen.isActive && rate.isActive)) byName.set(key, rate);
  }
  // O molde é a faixa de Belém que já existe: preço, peso e janelas iguais para toda a região.
  const belem = byName.get("motoboy belém");
  const mold = {
    priceCents: belem?.priceCents ?? FALLBACK_PRICE_CENTS,
    weightMinGrams: belem?.weightMinGrams ?? 0,
    weightMaxGrams: belem?.weightMaxGrams ?? 30000,
    deliveryWindows: belem && belem.deliveryWindows.length > 0 ? belem.deliveryWindows : FALLBACK_WINDOWS,
  };
  console.log(`Molde: R$ ${(mold.priceCents / 100).toFixed(2)}, ${mold.weightMinGrams}–${mold.weightMaxGrams} g, janelas ${mold.deliveryWindows.map((w) => `${w.start}–${w.end} (até ${w.cutoff})`).join(", ")}`);

  for (const city of MOTOBOY_CITIES) {
    const existing = byName.get(city.name.toLowerCase());
    if (existing) {
      const same = existing.kind === "motoboy" && existing.cepStart === city.cepStart && existing.cepEnd === city.cepEnd && existing.isActive;
      console.log(`${city.name}: já existe (${existing.cepStart}–${existing.cepEnd}, ${existing.kind}, ${existing.isActive ? "ativa" : "INATIVA"})${same ? "" : " — CONFIRA no painel: faixa ou tipo diferentes"}`);
      continue;
    }
    console.log(`${city.name}: criar ${city.cepStart}–${city.cepEnd}${apply ? "" : " (simulação)"}`);
    if (apply) {
      await createShippingRate(db, {
        name: city.name,
        cepStart: city.cepStart,
        cepEnd: city.cepEnd,
        weightMinGrams: mold.weightMinGrams,
        weightMaxGrams: mold.weightMaxGrams,
        priceCents: mold.priceCents,
        deliveryDaysMin: 0,
        deliveryDaysMax: 0,
        kind: "motoboy",
        deliveryWindows: mold.deliveryWindows,
        userId: owner.id,
      });
    }
  }

  const correios = byName.get(CORREIOS_TO_DISABLE.toLowerCase());
  if (!correios) {
    console.log(`${CORREIOS_TO_DISABLE}: não existe — nada a desligar.`);
  } else if (!correios.isActive) {
    console.log(`${CORREIOS_TO_DISABLE}: já está desligada.`);
  } else {
    console.log(`${CORREIOS_TO_DISABLE}: desligar${apply ? "" : " (simulação)"} — fora da área do motoboy o frete passa a ser calculado pela equipe`);
    if (apply) {
      await updateShippingRate(db, {
        id: correios.id,
        name: correios.name,
        cepStart: correios.cepStart,
        cepEnd: correios.cepEnd,
        weightMinGrams: correios.weightMinGrams,
        weightMaxGrams: correios.weightMaxGrams,
        priceCents: correios.priceCents,
        deliveryDaysMin: correios.deliveryDaysMin,
        deliveryDaysMax: correios.deliveryDaysMax,
        kind: correios.kind,
        deliveryWindows: correios.deliveryWindows,
        isActive: false,
        userId: owner.id,
      });
    }
  }
  console.log(apply ? `Gravado (auditoria: ${owner.name ?? owner.id}).` : "Simulação — rode com --apply para gravar.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
