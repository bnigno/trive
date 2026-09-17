// A região do motoboy (decisão da dona, 2026-09-17): Belém (com Icoaraci,
// Outeiro e Mosqueiro — CEP 66), Ananindeua, Marituba, Castanhal, Santa
// Izabel, Benevides e Santa Bárbara, cada uma com a faixa oficial de CEP do
// município. PURO: dado o retrato das faixas de frete, diz o que converter
// (faixa que já cobre a cidade, de qualquer tipo, vira motoboy com a faixa
// oficial e o nome padrão — preço e peso da dona ficam), o que criar (cidade
// sem faixa, com o molde da primeira cidade) e o que avisar. O script
// scripts/frete-motoboy-regiao.ts aplica.
import type { DeliveryWindow, ShippingKind } from "@/core/shipping/delivery-windows";

export interface MotoboyCity {
  name: string;
  cepStart: string;
  cepEnd: string;
}

/** Faixas oficiais dos Correios por município (as extremidades cobrem o município inteiro). */
export const MOTOBOY_CITIES: readonly MotoboyCity[] = [
  { name: "Motoboy Belém", cepStart: "66000000", cepEnd: "66999999" },
  { name: "Motoboy Ananindeua", cepStart: "67000000", cepEnd: "67199999" },
  { name: "Motoboy Marituba", cepStart: "67200000", cepEnd: "67299999" },
  { name: "Motoboy Castanhal", cepStart: "68740000", cepEnd: "68749999" },
  { name: "Motoboy Santa Izabel", cepStart: "68790000", cepEnd: "68794999" },
  { name: "Motoboy Benevides", cepStart: "68795000", cepEnd: "68797999" },
  { name: "Motoboy Santa Bárbara", cepStart: "68798000", cepEnd: "68798999" },
];

export const DEFAULT_MOTOBOY_WINDOWS: readonly DeliveryWindow[] = [
  { start: "09:00", end: "12:00", cutoff: "08:00" },
  { start: "16:00", end: "19:00", cutoff: "13:00" },
  { start: "19:00", end: "21:00", cutoff: "17:00" },
];

const FALLBACK_MOLD = { priceCents: 1500, weightMinGrams: 0, weightMaxGrams: 30000 };

export interface RegionRate {
  id: string;
  name: string;
  kind: ShippingKind;
  cepStart: string;
  cepEnd: string;
  priceCents: number;
  weightMinGrams: number;
  weightMaxGrams: number;
  deliveryWindows: readonly DeliveryWindow[];
  isActive: boolean;
}

export interface RateTarget {
  name: string;
  kind: "motoboy";
  cepStart: string;
  cepEnd: string;
  priceCents: number;
  weightMinGrams: number;
  weightMaxGrams: number;
  deliveryWindows: readonly DeliveryWindow[];
}

export interface MotoboyRegionPlan {
  /** Faixa existente que passa a ser a cidade (preço e peso mantidos). */
  convert: { rate: RegionRate; to: RateTarget; changes: string[] }[];
  /** Cidade sem faixa: nasce com o molde. */
  create: RateTarget[];
  /** Cidade já certa: nada a fazer. */
  keep: { rate: RegionRate; city: MotoboyCity }[];
  /** Faixa nacional (Correios para todo o Brasil) ativa: sob consulta = inativa. */
  deactivate: RegionRate[];
  warnings: string[];
}

/** Cobre o Brasil inteiro: não é faixa de cidade. */
export function isNationwide(rate: { cepStart: string; cepEnd: string }): boolean {
  return rate.cepStart === "00000000" && rate.cepEnd === "99999999";
}

function overlaps(rate: { cepStart: string; cepEnd: string }, city: MotoboyCity): boolean {
  return rate.cepStart <= city.cepEnd && rate.cepEnd >= city.cepStart;
}

function sameWindows(a: readonly DeliveryWindow[], b: readonly DeliveryWindow[]): boolean {
  return a.length === b.length && a.every((w, i) => w.start === b[i].start && w.end === b[i].end && w.cutoff === b[i].cutoff);
}

export function planMotoboyRegion(rates: readonly RegionRate[], cities: readonly MotoboyCity[] = MOTOBOY_CITIES): MotoboyRegionPlan {
  const plan: MotoboyRegionPlan = { convert: [], create: [], keep: [], deactivate: [], warnings: [] };
  // As janelas da região: as de uma faixa de motoboy que já exista, senão as padrão.
  const existingMotoboy = rates.find((rate) => rate.isActive && rate.kind === "motoboy" && rate.deliveryWindows.length > 0);
  const windows = existingMotoboy ? existingMotoboy.deliveryWindows : DEFAULT_MOTOBOY_WINDOWS;

  const claimed = new Set<string>();
  let mold: { priceCents: number; weightMinGrams: number; weightMaxGrams: number } | null = null;

  for (const city of cities) {
    const candidates = rates
      .filter((rate) => rate.isActive && !isNationwide(rate) && !claimed.has(rate.id) && overlaps(rate, city))
      .sort((a, b) => a.priceCents - b.priceCents || a.name.localeCompare(b.name));
    const rate = candidates[0];
    if (!rate) {
      const base = mold ?? FALLBACK_MOLD;
      plan.create.push({ name: city.name, kind: "motoboy", cepStart: city.cepStart, cepEnd: city.cepEnd, deliveryWindows: windows, ...base });
      continue;
    }
    claimed.add(rate.id);
    for (const extra of candidates.slice(1)) {
      plan.warnings.push(`"${extra.name}" (${extra.cepStart}–${extra.cepEnd}, ${extra.kind}) também cobre ${city.name.replace(/^Motoboy /, "")} — confira no painel se sobra ou se é outra cidade.`);
    }
    mold ??= { priceCents: rate.priceCents, weightMinGrams: rate.weightMinGrams, weightMaxGrams: rate.weightMaxGrams };
    const targetWindows = rate.kind === "motoboy" && rate.deliveryWindows.length > 0 ? rate.deliveryWindows : windows;
    const changes: string[] = [];
    if (rate.kind !== "motoboy") changes.push(`tipo ${rate.kind} → motoboy`);
    if (rate.cepStart !== city.cepStart || rate.cepEnd !== city.cepEnd) changes.push(`CEP ${rate.cepStart}–${rate.cepEnd} → ${city.cepStart}–${city.cepEnd}`);
    if (!sameWindows(rate.deliveryWindows, targetWindows)) changes.push(`janelas → ${targetWindows.map((w) => `${w.start}–${w.end} (até ${w.cutoff})`).join(", ")}`);
    if (rate.name !== city.name) changes.push(`nome "${rate.name}" → "${city.name}"`);
    if (changes.length === 0) {
      plan.keep.push({ rate, city });
      continue;
    }
    plan.convert.push({
      rate,
      to: {
        name: city.name,
        kind: "motoboy",
        cepStart: city.cepStart,
        cepEnd: city.cepEnd,
        priceCents: rate.priceCents,
        weightMinGrams: rate.weightMinGrams,
        weightMaxGrams: rate.weightMaxGrams,
        deliveryWindows: targetWindows,
      },
      changes,
    });
  }

  // Correios "para todo o Brasil" ativa cobraria um valor fixo fora da região: sob consulta é ficar inativa.
  for (const rate of rates) {
    if (rate.isActive && isNationwide(rate) && rate.kind === "correios") plan.deactivate.push(rate);
  }
  return plan;
}
