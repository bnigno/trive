// Cadastro do cliente no bot: máscara do CPF, endereço legível e a regra de
// quando o cadastro salvo serve para fechar pedido.
import { describe, expect, it } from "vitest";

import {
  formatSavedAddress,
  isAddressUsable,
  maskDocument,
  summarizeRegistration,
  type SavedAddress,
} from "../../src/core/bot/customer";
import { BOT_TOOL_INPUT_SCHEMAS } from "../../src/core/bot/tools";

const enderecoCompleto: SavedAddress = {
  postalCode: "66000000",
  street: "Rua das Flores",
  number: "200",
  complement: null,
  district: "Centro",
  city: "Belém",
  state: "PA",
};

describe("maskDocument", () => {
  it("mostra só os dois últimos dígitos", () => {
    expect(maskDocument("52998224725")).toBe("•••.•••.•••-25");
  });

  it("aceita CPF já pontuado", () => {
    expect(maskDocument("529.982.247-25")).toBe("•••.•••.•••-25");
  });

  it("NUNCA devolve o documento inteiro", () => {
    const mascarado = maskDocument("52998224725") ?? "";
    expect(mascarado).not.toContain("52998224725");
    expect(mascarado.replace(/\D/g, "")).toHaveLength(2);
  });

  it("devolve null quando não há documento utilizável", () => {
    expect(maskDocument(null)).toBeNull();
    expect(maskDocument("12")).toBeNull();
  });
});

describe("formatSavedAddress", () => {
  it("monta o endereço legível com CEP formatado", () => {
    expect(formatSavedAddress(enderecoCompleto)).toBe(
      "Rua das Flores, 200 — Centro, Belém/PA · CEP 66000-000",
    );
  });

  it("inclui o complemento entre parênteses", () => {
    expect(
      formatSavedAddress({ ...enderecoCompleto, complement: "Apto 302" }),
    ).toContain("Rua das Flores, 200 (Apto 302)");
  });

  it("não quebra com endereço parcial e devolve null sem endereço", () => {
    expect(
      formatSavedAddress({ ...enderecoCompleto, district: null, city: null, state: null }),
    ).toBe("Rua das Flores, 200 · CEP 66000-000");
    expect(formatSavedAddress(null)).toBeNull();
  });
});

describe("isAddressUsable", () => {
  it("aceita endereço completo", () => {
    expect(isAddressUsable(enderecoCompleto)).toBe(true);
  });

  it("recusa endereço sem número, sem cidade ou com CEP incompleto", () => {
    expect(isAddressUsable({ ...enderecoCompleto, number: null })).toBe(false);
    expect(isAddressUsable({ ...enderecoCompleto, city: "  " })).toBe(false);
    expect(isAddressUsable({ ...enderecoCompleto, postalCode: "6600" })).toBe(false);
    expect(isAddressUsable(null)).toBe(false);
  });
});

describe("summarizeRegistration", () => {
  it("entrega nome e endereço, mas o CPF só mascarado", () => {
    const texto = summarizeRegistration({
      fullName: "Marcielen Trindade da Silva",
      documentDigits: "52998224725",
      address: enderecoCompleto,
    });
    expect(texto).toContain("Marcielen Trindade da Silva");
    expect(texto).toContain("Rua das Flores, 200");
    expect(texto).toContain("•••.•••.•••-25");
    // A garantia central: o documento inteiro nunca chega ao modelo.
    expect(texto).not.toContain("52998224725");
    expect(texto).toContain("usar_cadastro_salvo");
  });

  it("com endereço incompleto, manda coletar em vez de reaproveitar", () => {
    const texto = summarizeRegistration({
      fullName: "Elen Lopes",
      documentDigits: "52998224725",
      address: { ...enderecoCompleto, number: null },
    });
    expect(texto).toContain("incompleto");
    expect(texto).toContain("Não use usar_cadastro_salvo");
  });
});

describe("criar_pedido: cadastro salvo x dados completos", () => {
  const schema = BOT_TOOL_INPUT_SCHEMAS["criar_pedido"];
  const itens = [{ sku: "POLO-VERD-P", quantidade: 1 }];
  const completo = {
    itens,
    nome_completo: "Maria da Silva",
    cpf: "52998224725",
    cep: "01310100",
    rua: "Av. Paulista",
    numero: "1000",
    bairro: "Bela Vista",
    cidade: "São Paulo",
    uf: "SP",
  };

  it("aceita só itens + usar_cadastro_salvo", () => {
    const r = schema.safeParse({ itens, usar_cadastro_salvo: true });
    expect(r.success).toBe(true);
  });

  it("aceita o conjunto completo sem cadastro salvo", () => {
    expect(schema.safeParse(completo).success).toBe(true);
  });

  it("RECUSA o meio-termo: sem cadastro salvo e faltando endereço", () => {
    const { cep: _cep, rua: _rua, ...semEndereco } = completo;
    const r = schema.safeParse(semEndereco);
    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path[0]);
    expect(campos).toContain("cep");
    expect(campos).toContain("rua");
  });

  it("buscar_cadastro não aceita campo nenhum", () => {
    expect(BOT_TOOL_INPUT_SCHEMAS["buscar_cadastro"].safeParse({}).success).toBe(true);
    expect(
      BOT_TOOL_INPUT_SCHEMAS["buscar_cadastro"].safeParse({ telefone: "+5511999" })
        .success,
    ).toBe(false);
  });
});
