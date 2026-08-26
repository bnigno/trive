import { describe, expect, it } from "vitest";

import {
  buildBotSystemPrompt,
  truncateForWhatsApp,
} from "../../src/core/bot/prompt";
import {
  BOT_TOOL_INPUT_SCHEMAS,
  BOT_TOOL_NAMES,
  BOT_TOOLS,
} from "../../src/core/bot/tools";

const promptOptions = {
  storeName: "TRIVË",
  extraInstructions: "",
  siteUrl: "https://trive.com.br",
};

describe("buildBotSystemPrompt", () => {
  it("é determinístico: duas chamadas idênticas produzem o mesmo texto", () => {
    expect(buildBotSystemPrompt(promptOptions)).toBe(
      buildBotSystemPrompt(promptOptions),
    );
  });

  it("contém a persona com o nome da loja e o site", () => {
    const prompt = buildBotSystemPrompt(promptOptions);
    expect(prompt).toContain("TRIVË");
    expect(prompt).toContain("https://trive.com.br");
    expect(prompt).toContain("WhatsApp");
  });

  it("contém as regras-chave numeradas", () => {
    const prompt = buildBotSystemPrompt(promptOptions);
    expect(prompt).toContain("REGRAS DURAS");
    expect(prompt).toContain("NESTA conversa");
    expect(prompt).toContain("criar_pedido");
    expect(prompt).toContain("transferir_para_atendente");
    expect(prompt).toContain("SAIR");
    expect(prompt).toContain("nota fiscal");
    expect(prompt).toContain("1.");
    expect(prompt).toContain("10.");
  });

  it("inclui extraInstructions rotulado quando não-vazio", () => {
    const prompt = buildBotSystemPrompt({
      ...promptOptions,
      extraInstructions: "Frete grátis acima de R$ 200.",
    });
    expect(prompt).toContain("Instruções do dono da loja:");
    expect(prompt).toContain("Frete grátis acima de R$ 200.");
  });

  it("omite o rótulo quando extraInstructions é vazio ou só espaços", () => {
    expect(buildBotSystemPrompt(promptOptions)).not.toContain(
      "Instruções do dono da loja:",
    );
    expect(
      buildBotSystemPrompt({ ...promptOptions, extraInstructions: "  \n " }),
    ).not.toContain("Instruções do dono da loja:");
  });
});

describe("BOT_TOOLS", () => {
  it("cobre exatamente os nomes de BOT_TOOL_NAMES, na mesma ordem", () => {
    expect(BOT_TOOLS.map((tool) => tool.name)).toEqual([...BOT_TOOL_NAMES]);
  });

  it("BOT_TOOL_INPUT_SCHEMAS cobre os mesmos nomes", () => {
    expect(Object.keys(BOT_TOOL_INPUT_SCHEMAS).sort()).toEqual(
      [...BOT_TOOL_NAMES].sort(),
    );
  });

  it("toda ferramenta tem description em pt-BR não-vazia", () => {
    for (const tool of BOT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("todo input_schema é objeto com additionalProperties false e required", () => {
    for (const tool of BOT_TOOLS) {
      expect(tool.input_schema["type"]).toBe("object");
      expect(tool.input_schema["additionalProperties"]).toBe(false);
      expect(Array.isArray(tool.input_schema["required"])).toBe(true);
    }
  });

  it("itens de criar_pedido também proíbem propriedades extras", () => {
    const criarPedido = BOT_TOOLS.find((tool) => tool.name === "criar_pedido");
    const properties = criarPedido?.input_schema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const itens = properties["itens"]?.["items"] as Record<string, unknown>;
    expect(itens["additionalProperties"]).toBe(false);
    expect(itens["required"]).toEqual(["sku", "quantidade"]);
  });

  it("required de criar_pedido cobre os obrigatórios e exclui os opcionais", () => {
    const criarPedido = BOT_TOOLS.find((tool) => tool.name === "criar_pedido");
    const required = criarPedido?.input_schema["required"] as string[];
    expect([...required].sort()).toEqual(
      [
        "itens",
        "nome_completo",
        "cpf",
        "cep",
        "rua",
        "numero",
        "bairro",
        "cidade",
        "uf",
      ].sort(),
    );
    expect(required).not.toContain("complemento");
    expect(required).not.toContain("cupom");
  });
});

describe("BOT_TOOL_INPUT_SCHEMAS (validação de runtime)", () => {
  const pedidoValido = {
    itens: [{ sku: "CAM-P-AZUL", quantidade: 2 }],
    nome_completo: "Maria da Silva",
    cpf: "12345678901",
    cep: "01310100",
    rua: "Av. Paulista",
    numero: "1000",
    bairro: "Bela Vista",
    cidade: "São Paulo",
    uf: "SP",
  };

  it("listar_produtos: aceita vazio e busca; rejeita extras", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.listar_produtos;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ busca: "camiseta" }).success).toBe(true);
    expect(schema.safeParse({ busca: 1 }).success).toBe(false);
    expect(schema.safeParse({ categoria: "x" }).success).toBe(false);
  });

  it("detalhar_produto: exige produto", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.detalhar_produto;
    expect(schema.safeParse({ produto: "CAM-P-AZUL" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ produto: "" }).success).toBe(false);
  });

  it("cotar_frete: CEP com 8 dígitos; máscara comum é aceita e normalizada", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.cotar_frete;
    expect(schema.safeParse({ cep: "01310100" }).success).toBe(true);
    // O modelo repassa o que o cliente digitou: "01310-100" vira "01310100".
    const mascarado = schema.safeParse({ cep: "01310-100" });
    expect(mascarado.success).toBe(true);
    expect((mascarado as { data: { cep: string } }).data.cep).toBe("01310100");
    expect(schema.safeParse({ cep: "0131010" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("criar_pedido: aceita pedido completo com e sem opcionais", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.criar_pedido;
    expect(schema.safeParse(pedidoValido).success).toBe(true);
    expect(
      schema.safeParse({
        ...pedidoValido,
        complemento: "Apto 12",
        cupom: "BEMVINDA10",
      }).success,
    ).toBe(true);
  });

  it("criar_pedido: rejeita CPF, quantidade, itens e UF inválidos", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.criar_pedido;
    expect(schema.safeParse({ ...pedidoValido, cpf: "1234567890" }).success).toBe(
      false,
    );
    // CPF mascarado é normalizado para 11 dígitos aqui; o dígito verificador
    // (isValidCpf) continua sendo checado pelo executor de criar_pedido.
    const cpfMascarado = schema.safeParse({
      ...pedidoValido,
      cpf: "123.456.789-01",
    });
    expect(cpfMascarado.success).toBe(true);
    expect((cpfMascarado as { data: { cpf: string } }).data.cpf).toBe(
      "12345678901",
    );
    expect(
      schema.safeParse({
        ...pedidoValido,
        itens: [{ sku: "CAM-P-AZUL", quantidade: 0 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...pedidoValido,
        itens: [{ sku: "CAM-P-AZUL", quantidade: 1.5 }],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...pedidoValido, itens: [] }).success).toBe(false);
    expect(schema.safeParse({ ...pedidoValido, uf: "SPO" }).success).toBe(false);
    const semBairro: Record<string, unknown> = { ...pedidoValido };
    delete semBairro["bairro"];
    expect(schema.safeParse(semBairro).success).toBe(false);
    expect(
      schema.safeParse({ ...pedidoValido, observacao: "embrulhar" }).success,
    ).toBe(false);
  });

  it("status_do_pedido: número opcional, inteiro positivo", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.status_do_pedido;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ numero_do_pedido: 42 }).success).toBe(true);
    expect(schema.safeParse({ numero_do_pedido: "42" }).success).toBe(false);
    expect(schema.safeParse({ numero_do_pedido: 0 }).success).toBe(false);
  });

  it("transferir_para_atendente: exige motivo", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.transferir_para_atendente;
    expect(schema.safeParse({ motivo: "cliente pediu humano" }).success).toBe(
      true,
    );
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ motivo: "" }).success).toBe(false);
  });
});

describe("truncateForWhatsApp", () => {
  it("devolve texto curto inalterado (inclusive no limite exato)", () => {
    expect(truncateForWhatsApp("oi", 10)).toBe("oi");
    expect(truncateForWhatsApp("a".repeat(10), 10)).toBe("a".repeat(10));
  });

  it("corta texto multi-linha em quebra de linha, com reticências", () => {
    const text = Array.from({ length: 50 }, (_, i) => `linha ${i}`).join("\n");
    const result = truncateForWhatsApp(text, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("…")).toBe(true);
    const body = result.slice(0, -1);
    // O corpo é um prefixo do original terminando exatamente numa linha completa.
    expect(text.startsWith(body)).toBe(true);
    expect(text[body.length]).toBe("\n");
  });

  it("usa max = 1200 por padrão", () => {
    const text = Array.from({ length: 300 }, (_, i) => `linha ${i}`).join("\n");
    expect(text.length).toBeGreaterThan(1200);
    const result = truncateForWhatsApp(text);
    expect(result.length).toBeLessThanOrEqual(1200);
    expect(result.endsWith("…")).toBe(true);
  });

  it("nunca corta URL no meio: corta antes dela", () => {
    const prefixo = "Confira o produto que separei para você aqui na loja: ";
    const url = "https://trive.com.br/produtos/camiseta-azul-premium";
    const text = prefixo + url;
    const max = prefixo.length + 10; // o corte cairia no meio da URL
    const result = truncateForWhatsApp(text, max);
    expect(result).not.toContain("http");
    expect(result).toBe(prefixo.trimEnd() + "…");
  });

  it("mantém URL inteira quando ela cabe antes do corte", () => {
    const url = "https://trive.com.br/p/1";
    const text = url + " " + "b".repeat(200);
    const result = truncateForWhatsApp(text, 80);
    expect(result).toContain(url);
    expect(result.length).toBeLessThanOrEqual(80);
  });
});
