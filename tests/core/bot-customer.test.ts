// Cadastro do cliente no bot: máscara do CPF, endereço legível e a regra de
// quando o cadastro salvo serve para fechar pedido.
import { describe, expect, it } from "vitest";

import {
  formatSavedAddress,
  formatSavedAddressLines,
  isAddressUsable,
  maskDocument,
  pickSavedAddressForCep,
  SAVED_ADDRESSES_MAX,
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
  isDefault: true,
};

const enderecoBenevides: SavedAddress = {
  postalCode: "68795000",
  street: "Rua da Praça",
  number: "12",
  complement: null,
  district: "Centro",
  city: "Benevides",
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

describe("pickSavedAddressForCep", () => {
  it("com CEP cotado, escolhe o endereço salvo com esse CEP — nunca o padrão em silêncio", () => {
    expect(pickSavedAddressForCep([enderecoCompleto, enderecoBenevides], "68795000")).toEqual({
      kind: "one",
      address: enderecoBenevides,
    });
    expect(pickSavedAddressForCep([enderecoCompleto, enderecoBenevides], "68795-000")).toEqual({
      kind: "one",
      address: enderecoBenevides,
    });
  });

  it("CEP cotado que não é de nenhum endereço salvo: none, com os endereços usáveis", () => {
    expect(pickSavedAddressForCep([enderecoCompleto, enderecoBenevides], "01310100")).toEqual({
      kind: "none",
      usable: [enderecoCompleto, enderecoBenevides],
    });
  });

  it("dois endereços com o mesmo CEP: ambíguo (a cliente diz qual)", () => {
    const outroNumero = { ...enderecoCompleto, number: "500", isDefault: false };
    expect(pickSavedAddressForCep([enderecoCompleto, outroNumero], "66000000")).toEqual({
      kind: "ambiguous",
      matches: [enderecoCompleto, outroNumero],
    });
  });

  it("sem CEP cotado: um único usável serve; dois exigem escolha; incompletos não contam", () => {
    expect(pickSavedAddressForCep([enderecoCompleto], undefined)).toEqual({
      kind: "one",
      address: enderecoCompleto,
    });
    expect(pickSavedAddressForCep([enderecoCompleto, enderecoBenevides], undefined)).toEqual({
      kind: "none",
      usable: [enderecoCompleto, enderecoBenevides],
    });
    const incompleto = { ...enderecoBenevides, number: null };
    expect(pickSavedAddressForCep([enderecoCompleto, incompleto], undefined)).toEqual({
      kind: "one",
      address: enderecoCompleto,
    });
    expect(pickSavedAddressForCep([incompleto], "68795000")).toEqual({ kind: "none", usable: [] });
  });
});

describe("formatSavedAddressLines", () => {
  it("numera, mostra o CEP e marca padrão, incompleto e CEP já cotado", () => {
    const linhas = formatSavedAddressLines(
      [enderecoCompleto, enderecoBenevides, { ...enderecoBenevides, number: null }],
      { quotedCep: "68795000" },
    );
    expect(linhas[0]).toBe("1. Rua das Flores, 200 — Centro, Belém/PA · CEP 66000-000 (padrão)");
    expect(linhas[1]).toBe(
      "2. Rua da Praça, 12 — Centro, Benevides/PA · CEP 68795-000 (CEP já cotado nesta conversa)",
    );
    expect(linhas[2]).toContain("(incompleto; CEP já cotado nesta conversa)");
  });
});

describe("summarizeRegistration", () => {
  it("entrega nome e endereço, mas o CPF só mascarado; manda cotar com o CEP do endereço", () => {
    const texto = summarizeRegistration({
      fullName: "Marcielen Trindade da Silva",
      documentDigits: "52998224725",
      addresses: [enderecoCompleto],
    });
    expect(texto).toContain("Marcielen Trindade da Silva");
    expect(texto).toContain("• Endereço: Rua das Flores, 200");
    expect(texto).toContain("•••.•••.•••-25");
    // A garantia central: o documento inteiro nunca chega ao modelo.
    expect(texto).not.toContain("52998224725");
    expect(texto).toContain("cotar_frete com o CEP 66000000");
    expect(texto).toContain("usar_cadastro_salvo true");
    expect(texto).toContain("OUTRO endereço");
  });

  it("com endereço incompleto, manda coletar o endereço — o CPF continua do cadastro", () => {
    const texto = summarizeRegistration({
      fullName: "Elen Lopes",
      documentDigits: "52998224725",
      addresses: [{ ...enderecoCompleto, number: null }],
    });
    expect(texto).toContain("incompleto");
    expect(texto).toContain("NÃO peça o CPF de novo");
    expect(texto).toContain("usar_cadastro_salvo true");
  });

  it("vários endereços: lista numerada com CEP, marca o padrão e o cotado, e manda confirmar QUAL", () => {
    const texto = summarizeRegistration(
      {
        fullName: "Marcielen Trindade da Silva",
        documentDigits: "52998224725",
        addresses: [enderecoCompleto, enderecoBenevides],
      },
      { quotedCep: "68795000" },
    );
    expect(texto).toContain("• Endereços salvos (2):");
    expect(texto).toContain("1. Rua das Flores, 200 — Centro, Belém/PA · CEP 66000-000 (padrão)");
    expect(texto).toContain(
      "2. Rua da Praça, 12 — Centro, Benevides/PA · CEP 68795-000 (CEP já cotado nesta conversa)",
    );
    expect(texto).toContain("EM QUAL destes endereços é a entrega");
    expect(texto).toContain("cotar_frete com o CEP do endereço escolhido");
    expect(texto).not.toContain("ATENÇÃO");
  });

  it("teto de endereços e aviso quando o CEP cotado não é de nenhum salvo", () => {
    const muitos = Array.from({ length: SAVED_ADDRESSES_MAX + 2 }, (_, i) => ({
      ...enderecoBenevides,
      number: String(i + 1),
      isDefault: i === 0,
    }));
    const texto = summarizeRegistration(
      { fullName: "Ana", documentDigits: null, addresses: muitos },
      { quotedCep: "01310100" },
    );
    expect(texto).toContain(`• Endereços salvos (5, mostrando ${SAVED_ADDRESSES_MAX}):`);
    expect(texto).toContain(`${SAVED_ADDRESSES_MAX}. Rua da Praça`);
    expect(texto).not.toContain(`${SAVED_ADDRESSES_MAX + 1}. Rua da Praça`);
    expect(texto).toContain(
      "ATENÇÃO: o CEP cotado nesta conversa (01310-100) não é de nenhum endereço salvo",
    );
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

  it("usar_cadastro_salvo + endereço novo COMPLETO é aceito (nome e CPF ficam do cadastro)", () => {
    const { nome_completo: _n, cpf: _c, ...enderecoNovo } = completo;
    expect(schema.safeParse({ ...enderecoNovo, usar_cadastro_salvo: true }).success).toBe(true);
  });

  it("usar_cadastro_salvo + endereço pela metade é RECUSADO citando o campo que falta", () => {
    const { nome_completo: _n, cpf: _c, rua: _r, ...semRua } = completo;
    const r = schema.safeParse({ ...semRua, usar_cadastro_salvo: true });
    expect(r.success).toBe(false);
    const issues = r.success ? [] : r.error.issues;
    expect(issues.map((i) => i.path[0])).toEqual(["rua"]);
    expect(issues[0]?.message).toContain("falta rua");
  });

  it("buscar_cadastro não aceita campo nenhum", () => {
    expect(BOT_TOOL_INPUT_SCHEMAS["buscar_cadastro"].safeParse({}).success).toBe(true);
    expect(
      BOT_TOOL_INPUT_SCHEMAS["buscar_cadastro"].safeParse({ telefone: "+5511999" })
        .success,
    ).toBe(false);
  });
});
