// A região do motoboy (puro): o retrato do painel de produção de 17/09
// (4 cidades como Correios, 2 nacionais inativas) vira o plano certo; o
// cenário já convertido não faz nada; faixa nacional ativa é desligada.
import { describe, expect, it } from "vitest";

import { DEFAULT_MOTOBOY_WINDOWS, MOTOBOY_CITIES, planMotoboyRegion, type RegionRate } from "@/core/shipping/motoboy-region";

function rate(over: Partial<RegionRate> & { id: string; name: string; cepStart: string; cepEnd: string }): RegionRate {
  return { kind: "correios", priceCents: 1000, weightMinGrams: 0, weightMaxGrams: 20000, deliveryWindows: [], isActive: true, ...over };
}

/** O painel de produção como estava (print de 17/09/2026, 10:53). */
const PRODUCTION: RegionRate[] = [
  rate({ id: "ben", name: "Benevides", cepStart: "68795000", cepEnd: "68797999", priceCents: 800 }),
  rate({ id: "ana", name: "Ananindeua", cepStart: "67000000", cepEnd: "67149999" }),
  rate({ id: "bel", name: "Belém", cepStart: "66000000", cepEnd: "66999999" }),
  rate({ id: "mar", name: "Marituba", cepStart: "67200000", cepEnd: "67219999" }),
  rate({ id: "gratis", name: "Frete grátis (teste de pagamento)", cepStart: "00000000", cepEnd: "99999999", priceCents: 0, weightMaxGrams: 20, isActive: false }),
  rate({ id: "padrao", name: "Entrega padrão (todo o Brasil)", cepStart: "00000000", cepEnd: "99999999", priceCents: 2000, weightMaxGrams: 30000, isActive: false }),
];

describe("planMotoboyRegion", () => {
  it("produção de 17/09: converte as 4 cidades (tipo, CEP curto, janelas, nome; preço e peso ficam), cria as 3 que faltam com o molde de Belém e não mexe nas nacionais inativas", () => {
    const plan = planMotoboyRegion(PRODUCTION);

    expect(plan.convert.map((c) => [c.rate.name, c.to.name, c.to.cepStart, c.to.cepEnd, c.to.priceCents])).toEqual([
      ["Belém", "Motoboy Belém", "66000000", "66999999", 1000],
      ["Ananindeua", "Motoboy Ananindeua", "67000000", "67199999", 1000],
      ["Marituba", "Motoboy Marituba", "67200000", "67299999", 1000],
      ["Benevides", "Motoboy Benevides", "68795000", "68797999", 800],
    ]);
    for (const item of plan.convert) {
      expect(item.to.kind).toBe("motoboy");
      expect(item.to.deliveryWindows).toEqual(DEFAULT_MOTOBOY_WINDOWS);
      expect(item.to.weightMaxGrams).toBe(20000);
    }
    expect(plan.convert[0].changes).toEqual([
      "tipo correios → motoboy",
      "janelas → 09:00–12:00 (até 08:00), 16:00–19:00 (até 13:00), 19:00–21:00 (até 17:00)",
      'nome "Belém" → "Motoboy Belém"',
    ]);
    expect(plan.convert[1].changes).toContain("CEP 67000000–67149999 → 67000000–67199999");

    // As que faltam nascem com o molde da primeira cidade (Belém: R$ 10, 0–20 kg).
    expect(plan.create.map((c) => [c.name, c.cepStart, c.cepEnd, c.priceCents, c.weightMaxGrams])).toEqual([
      ["Motoboy Castanhal", "68740000", "68749999", 1000, 20000],
      ["Motoboy Santa Izabel", "68790000", "68794999", 1000, 20000],
      ["Motoboy Santa Bárbara", "68798000", "68798999", 1000, 20000],
    ]);
    expect(plan.keep).toEqual([]);
    expect(plan.deactivate).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("já convertido: nada a fazer; as janelas da região vêm da faixa de motoboy que já existe", () => {
    const converted: RegionRate[] = MOTOBOY_CITIES.map((city, index) =>
      rate({ id: `c${index}`, name: city.name, cepStart: city.cepStart, cepEnd: city.cepEnd, kind: "motoboy", deliveryWindows: [{ start: "18:00", end: "22:00", cutoff: "17:00" }] }),
    );
    const plan = planMotoboyRegion(converted);
    expect(plan.convert).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.keep).toHaveLength(7);

    // Uma cidade a menos: a nova copia as janelas (e o molde) das que existem, não as padrão.
    const missingOne = planMotoboyRegion(converted.slice(0, 6));
    expect(missingOne.create).toHaveLength(1);
    expect(missingOne.create[0].name).toBe("Motoboy Santa Bárbara");
    expect(missingOne.create[0].deliveryWindows).toEqual([{ start: "18:00", end: "22:00", cutoff: "17:00" }]);
  });

  it("Correios para todo o Brasil ATIVA é desligada (sob consulta = inativa); faixa larga que cobre duas cidades vira a primeira e avisa; inativa não conta", () => {
    const plan = planMotoboyRegion([
      rate({ id: "padrao", name: "Entrega padrão (todo o Brasil)", cepStart: "00000000", cepEnd: "99999999", priceCents: 2000 }),
      rate({ id: "larga", name: "Grande Belém", cepStart: "66000000", cepEnd: "67299999", priceCents: 1200 }),
      rate({ id: "velha", name: "Belém antiga", cepStart: "66000000", cepEnd: "66999999", priceCents: 900, isActive: false }),
    ]);
    expect(plan.deactivate.map((r) => r.id)).toEqual(["padrao"]);
    // A faixa larga vira Belém (encolhe para a faixa oficial); Ananindeua e Marituba nascem novas.
    expect(plan.convert.map((c) => [c.rate.id, c.to.name, c.to.cepEnd])).toEqual([["larga", "Motoboy Belém", "66999999"]]);
    expect(plan.create.map((c) => c.name)).toEqual([
      "Motoboy Ananindeua",
      "Motoboy Marituba",
      "Motoboy Castanhal",
      "Motoboy Santa Izabel",
      "Motoboy Benevides",
      "Motoboy Santa Bárbara",
    ]);
    expect(plan.create[0].priceCents).toBe(1200);
    expect(plan.warnings).toEqual([]);

    // Duas faixas ativas na mesma cidade: a mais barata vira a cidade, a outra é avisada.
    const twice = planMotoboyRegion([
      rate({ id: "a", name: "Belém centro", cepStart: "66000000", cepEnd: "66499999", priceCents: 800 }),
      rate({ id: "b", name: "Belém ilhas", cepStart: "66500000", cepEnd: "66999999", priceCents: 1500 }),
    ]);
    expect(twice.convert.map((c) => c.rate.id)).toEqual(["a"]);
    expect(twice.warnings[0]).toContain('"Belém ilhas"');
  });
});
