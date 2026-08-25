import { describe, expect, it } from "vitest";

import { extractVariables, renderTemplate } from "@/core/whatsapp/render";

describe("renderTemplate", () => {
  it("substitui todas as variáveis, inclusive repetidas", () => {
    const template =
      "Oi {{nome}}! Seu pedido {{numero_pedido}} foi pago. Obrigado, {{nome}}!";
    const result = renderTemplate(template, {
      nome: "Ana",
      numero_pedido: "TRV-0042",
    });
    expect(result).toBe("Oi Ana! Seu pedido TRV-0042 foi pago. Obrigado, Ana!");
  });

  it("chave ausente vira string vazia e NUNCA lança", () => {
    const result = renderTemplate("Oi {{nome}}, total {{total}}.", { nome: "Bia" });
    expect(result).toBe("Oi Bia, total .");
  });

  it("vars extras são ignoradas e template sem variáveis passa intacto", () => {
    expect(renderTemplate("Mensagem fixa.", { nome: "Ana", extra: "x" })).toBe(
      "Mensagem fixa.",
    );
  });

  it("tolera espaços dentro das chaves: {{ nome }}", () => {
    expect(renderTemplate("Oi {{ nome }}!", { nome: "Caio" })).toBe("Oi Caio!");
  });

  it("chaves malformadas ({nome}, {{nome) ficam como estão", () => {
    expect(renderTemplate("Oi {nome} e {{nome", { nome: "Ana" })).toBe(
      "Oi {nome} e {{nome",
    );
  });

  it("valor vazio explícito também é aceito", () => {
    expect(renderTemplate("A{{x}}B", { x: "" })).toBe("AB");
  });
});

describe("extractVariables", () => {
  it("lista as chaves na ordem de aparição, sem repetição", () => {
    expect(
      extractVariables("Oi {{nome}}, pedido {{numero_pedido}} de {{nome}}: {{total}}"),
    ).toEqual(["nome", "numero_pedido", "total"]);
  });

  it("template sem variáveis retorna lista vazia", () => {
    expect(extractVariables("Mensagem fixa, sem chaves.")).toEqual([]);
  });

  it("aceita dígitos, underscore e ponto nas chaves, com espaços opcionais", () => {
    expect(extractVariables("{{ var_1 }} e {{cliente.nome}}")).toEqual([
      "var_1",
      "cliente.nome",
    ]);
  });
});
