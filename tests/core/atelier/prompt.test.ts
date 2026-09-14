import { describe, expect, it } from "vitest";

import { arrivalUserText, buildArrivalPrompt } from "@/core/atelier/prompt";

const input = {
  storeName: "TRIVÉ",
  manifesto: "",
  categories: [{ name: "Vestidos", slug: "vestidos" }],
  knownColors: ["Areia"],
  knownSizes: ["P", "M"],
  knownSuppliers: ["Aurora"],
};

describe("buildArrivalPrompt", () => {
  it("é determinístico e traz salas, cores, tamanhos, fornecedores e as regras do recado", () => {
    const prompt = buildArrivalPrompt(input);
    expect(prompt).toBe(buildArrivalPrompt(input));
    expect(prompt).toContain("Vestidos (slug: vestidos)");
    expect(prompt).toContain("CORES já usadas na loja (prefira estas grafias): Areia.");
    expect(prompt).toContain("FORNECEDORES cadastrados (prefira estas grafias em supplierName): Aurora.");
    expect(prompt).toContain('"do P ao GG" → ["P","M","G","GG"]');
    expect(prompt).toContain('"custou 120" = 12000');
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("sem sala nem fornecedor, diz isso em vez de listar vazio", () => {
    const prompt = buildArrivalPrompt({ ...input, categories: [], knownSuppliers: [] });
    expect(prompt).toContain("nenhuma sala cadastrada");
    expect(prompt).toContain("(nenhum cadastrado)");
  });
});

describe("arrivalUserText", () => {
  it("cita o recado; sem recado, pede a ficha só pelas fotos", () => {
    expect(arrivalUserText("  chegou o Longo Dunas ")).toContain('RECADO DA DONA: "chegou o Longo Dunas"');
    expect(arrivalUserText("")).toContain("só as fotos");
  });
});
