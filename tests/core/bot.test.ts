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
import {
  buildVariantMenu,
  colorOfVariant,
  formatVariantLines,
  pickImagePath,
  type BotVariant,
} from "../../src/core/bot/variants";
import { formatCentsBRL } from "../../src/lib/money";

const promptOptions = {
  storeName: "TRIVÉ",
  sellerName: "Lia",
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
    expect(prompt).toContain("TRIVÉ");
    expect(prompt).toContain("https://trive.com.br");
    expect(prompt).toContain("WhatsApp");
  });

  it("descreve a personalidade descolada e o elogio à escolha, com motivo real", () => {
    const prompt = buildBotSystemPrompt(promptOptions);
    expect(prompt).toContain("JEITO DE FALAR");
    expect(prompt).toContain("amiga estilosa");
    // Elogio tem que apontar algo REAL: elogio genérico repetido soa falso.
    expect(prompt).toContain("Elogie a ESCOLHA, não a pessoa");
    expect(prompt).toContain("motivo real");
    // O tom formal de call center é justamente o que o dono não quer.
    expect(prompt).toContain("prezada");
  });

  it("subordina a personalidade à exatidão e manda baixar a brincadeira em problema", () => {
    const prompt = buildBotSystemPrompt(promptOptions);
    // 17: exatidão ganha da graça; elogio nunca vira pressão de venda.
    expect(prompt).toContain("17.");
    expect(prompt).toContain("seja exata");
    expect(prompt).toContain("pressionar a compra");
    // 18: cliente irritada não recebe piada.
    expect(prompt).toContain("18.");
    expect(prompt).toContain("baixe a brincadeira");
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
    expect(prompt).toContain("15.");
    expect(prompt).toContain("19.");
  });

  it("exige confirmar cor e tamanho antes de pôr na sacola em peça com variação", () => {
    const prompt = buildBotSystemPrompt(promptOptions);
    expect(prompt).toContain("12.");
    expect(prompt).toContain("COR e TAMANHO");
    expect(prompt).toContain("SKU exato");
    // O bot não pode "chutar" o tamanho para adiantar a venda.
    expect(prompt).toContain("nunca escolha por ela");
    // A sacola é a fonte do pedido e o frete escolhido vai em criar_pedido.
    expect(prompt).toContain("13.");
    expect(prompt).toContain("passe em frete a opção que a cliente escolheu");
  });

  it("contém as regras de Pix manual, aviso ao dono e dinheiro na entrega", () => {
    const prompt = buildBotSystemPrompt(promptOptions);
    // Problema com o link → oferecer Pix manual; só a ferramenta confirma.
    expect(prompt).toContain("enviar_chave_pix");
    expect(prompt).toContain("NÃO prometa");
    // Cliente já fez o Pix → avisar o dono; nunca confirmar pagamento.
    expect(prompt).toContain("avisar_dono");
    expect(prompt).toContain("número do pedido e o valor");
    // Dinheiro na entrega só quando o cliente pedir explicitamente.
    expect(prompt).toContain('forma_de_pagamento "dinheiro_na_entrega"');
    expect(prompt).toContain("explicitamente");
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

  it("criar_pedido não tem campo sempre obrigatório: itens vêm da sacola e dados do cadastro salvo", () => {
    const criarPedido = BOT_TOOLS.find((tool) => tool.name === "criar_pedido");
    const required = criarPedido?.input_schema["required"] as string[];
    // A exigência de verdade (cadastro salvo OU conjunto completo) vive no
    // superRefine de criarPedidoSchema — o JSON schema só orienta o modelo.
    expect(required).toEqual([]);

    const properties = criarPedido?.input_schema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["usar_cadastro_salvo"]?.["type"]).toBe("boolean");
    expect(properties["usar_cadastro_salvo"]?.["default"]).toBe(false);
  });

  it("buscar_cadastro não recebe entrada: o telefone é o da conversa", () => {
    const buscar = BOT_TOOLS.find((tool) => tool.name === "buscar_cadastro");
    expect(buscar?.input_schema["required"]).toEqual([]);
    expect(buscar?.input_schema["properties"]).toEqual({});
    // O cliente não pode induzir o bot a consultar o cadastro de outra pessoa.
    expect(buscar?.input_schema["additionalProperties"]).toBe(false);
  });

  it("forma_de_pagamento de criar_pedido: enum online/dinheiro_na_entrega, default online", () => {
    const criarPedido = BOT_TOOLS.find((tool) => tool.name === "criar_pedido");
    const properties = criarPedido?.input_schema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const forma = properties["forma_de_pagamento"];
    expect(forma["enum"]).toEqual(["online", "dinheiro_na_entrega"]);
    expect(forma["default"]).toBe("online");
  });

  it("enviar_chave_pix: numero_do_pedido opcional; avisar_dono exige mensagem", () => {
    const enviarChavePix = BOT_TOOLS.find(
      (tool) => tool.name === "enviar_chave_pix",
    );
    expect(enviarChavePix?.input_schema["required"]).toEqual([]);
    const avisarDono = BOT_TOOLS.find((tool) => tool.name === "avisar_dono");
    expect(avisarDono?.input_schema["required"]).toEqual(["mensagem"]);
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

  it("listar_produtos: aceita vazio, busca e filtros; rejeita extras", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.listar_produtos;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ busca: "camiseta" }).success).toBe(true);
    expect(
      schema.safeParse({
        categoria: "vestidos",
        cor: "Preto",
        tamanho: "M",
        preco_maximo_reais: 300,
        pagina: 2,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ busca: 1 }).success).toBe(false);
    expect(schema.safeParse({ pagina: 0 }).success).toBe(false);
    expect(schema.safeParse({ ordenar: "x" }).success).toBe(false);
  });

  it("detalhar_produto: exige produto e aceita cor opcional", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.detalhar_produto;
    expect(schema.safeParse({ produto: "CAM-P-AZUL" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ produto: "" }).success).toBe(false);
    expect(
      schema.safeParse({ produto: "Camisa Polo", cor: "Verde" }).success,
    ).toBe(true);
    expect(schema.safeParse({ produto: "Camisa Polo", cor: "" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ produto: "Camisa Polo", tamanho: "P" }).success,
    ).toBe(false);
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
    // telefone é aceito e ignorado (caso real: o modelo coleta telefone por
    // instinto e rejeitá-lo travava a finalização do pedido).
    expect(
      schema.safeParse({ ...pedidoValido, telefone: "91981037536" }).success,
    ).toBe(true);
    const semBairro: Record<string, unknown> = { ...pedidoValido };
    delete semBairro["bairro"];
    expect(schema.safeParse(semBairro).success).toBe(false);
    expect(
      schema.safeParse({ ...pedidoValido, observacao: "embrulhar" }).success,
    ).toBe(false);
  });

  it("criar_pedido: forma_de_pagamento aceita os dois valores e assume online", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.criar_pedido;
    const semForma = schema.safeParse(pedidoValido);
    expect(semForma.success).toBe(true);
    expect(
      (semForma as { data: { forma_de_pagamento: string } }).data
        .forma_de_pagamento,
    ).toBe("online");
    expect(
      schema.safeParse({ ...pedidoValido, forma_de_pagamento: "online" })
        .success,
    ).toBe(true);
    const dinheiro = schema.safeParse({
      ...pedidoValido,
      forma_de_pagamento: "dinheiro_na_entrega",
    });
    expect(dinheiro.success).toBe(true);
    expect(
      (dinheiro as { data: { forma_de_pagamento: string } }).data
        .forma_de_pagamento,
    ).toBe("dinheiro_na_entrega");
    expect(
      schema.safeParse({ ...pedidoValido, forma_de_pagamento: "cash" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...pedidoValido, forma_de_pagamento: "" }).success,
    ).toBe(false);
  });

  it("status_do_pedido: número opcional, inteiro positivo", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.status_do_pedido;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ numero_do_pedido: 42 }).success).toBe(true);
    expect(schema.safeParse({ numero_do_pedido: "42" }).success).toBe(false);
    expect(schema.safeParse({ numero_do_pedido: 0 }).success).toBe(false);
  });

  it("enviar_chave_pix: número opcional, inteiro positivo; rejeita extras", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.enviar_chave_pix;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ numero_do_pedido: 1042 }).success).toBe(true);
    expect(schema.safeParse({ numero_do_pedido: "1042" }).success).toBe(false);
    expect(schema.safeParse({ numero_do_pedido: 0 }).success).toBe(false);
    expect(schema.safeParse({ numero_do_pedido: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ chave: "x" }).success).toBe(false);
  });

  it("avisar_dono: mensagem obrigatória de 1 a 300 caracteres", () => {
    const schema = BOT_TOOL_INPUT_SCHEMAS.avisar_dono;
    expect(
      schema.safeParse({ mensagem: "Pedido #1042: cliente diz que fez o Pix." })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ mensagem: "a".repeat(300) }).success).toBe(true);
    expect(schema.safeParse({ mensagem: "a".repeat(301) }).success).toBe(false);
    expect(schema.safeParse({ mensagem: "" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ mensagem: "ok", pedido: 1 }).success,
    ).toBe(false);
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

// ---------------------------------------------------------------------------
// Variações (cor, tamanho) — apresentação pura
// ---------------------------------------------------------------------------

function variante(
  sku: string,
  attributes: Record<string, string>,
  availableQty: number,
  priceCents = 8990,
): BotVariant {
  return { sku, attributes, priceCents, availableQty };
}

const POLO_AXES = ["cor", "tamanho"];
const POLO: BotVariant[] = [
  variante("POLO-VD-P", { cor: "Verde", tamanho: "P" }, 3),
  variante("POLO-VD-G", { cor: "Verde", tamanho: "G" }, 2),
  variante("POLO-AM-M", { cor: "Amarelo", tamanho: "M" }, 1),
  variante("POLO-AM-G", { cor: "Amarelo", tamanho: "G" }, 0),
];

describe("formatVariantLines", () => {
  it("agrupa por cor e mostra o preço UMA vez quando é igual em tudo", () => {
    expect(formatVariantLines(POLO, POLO_AXES)).toEqual([
      "Opções disponíveis (quantidade entre parênteses):",
      "• Verde: P (3), G (2)",
      "• Amarelo: M (1), G (esgotado)",
      `Preço: ${formatCentsBRL(8990)}`,
      "[SKU de cada combinação, para criar_pedido — NÃO mostre ao cliente: Verde · P=POLO-VD-P; Verde · G=POLO-VD-G; Amarelo · M=POLO-AM-M; Amarelo · G=POLO-AM-G]",
    ]);
  });

  it("segue a ordem de attributes_schema, nunca a ordem das chaves do jsonb", () => {
    // Mesmas chaves, ordem de inserção invertida: o rótulo não pode mudar.
    const invertido = [
      variante("POLO-VD-P", { tamanho: "P", cor: "Verde" }, 3),
      variante("POLO-VD-G", { tamanho: "G", cor: "Verde" }, 2),
    ];
    const direto = [
      variante("POLO-VD-P", { cor: "Verde", tamanho: "P" }, 3),
      variante("POLO-VD-G", { cor: "Verde", tamanho: "G" }, 2),
    ];
    expect(formatVariantLines(invertido, POLO_AXES)).toEqual(
      formatVariantLines(direto, POLO_AXES),
    );
    // Com o tamanho declarado primeiro, é o tamanho que agrupa.
    expect(formatVariantLines(direto, ["tamanho", "cor"])).toContain(
      "• P: Verde (3)",
    );
  });

  it("destaca o preço de cada combinação quando eles diferem", () => {
    const precosDiferentes = [
      variante("POLO-VD-P", { cor: "Verde", tamanho: "P" }, 3, 8990),
      variante("POLO-VD-GG", { cor: "Verde", tamanho: "GG" }, 1, 9990),
    ];
    const linhas = formatVariantLines(precosDiferentes, POLO_AXES);
    expect(linhas).toContain(
      `• Verde: P (3) — ${formatCentsBRL(8990)}, GG (1) — ${formatCentsBRL(9990)}`,
    );
    expect(linhas.some((linha) => linha.startsWith("Preço: "))).toBe(false);
  });

  it("eixo único: uma linha só, sem grupo", () => {
    const camiseta = [
      variante("CAM-P", { tamanho: "P" }, 5, 4490),
      variante("CAM-G", { tamanho: "G" }, 0, 4490),
    ];
    expect(formatVariantLines(camiseta, ["tamanho"])).toEqual([
      "Opções disponíveis (quantidade entre parênteses):",
      "• P (5), G (esgotado)",
      `Preço: ${formatCentsBRL(4490)}`,
      "[SKU de cada combinação, para criar_pedido — NÃO mostre ao cliente: P=CAM-P; G=CAM-G]",
    ]);
  });

  it("produto sem variação: linha única com preço, estoque e SKU", () => {
    const caneca = [variante("CANECA-AZUL", {}, 10, 4990)];
    const esperado = [
      `• ${formatCentsBRL(4990)} (10 disponíveis) — SKU: CANECA-AZUL`,
    ];
    expect(formatVariantLines(caneca, [])).toEqual(esperado);
    // Eixo declarado que nenhuma variante preenche não vira rótulo vazio.
    expect(formatVariantLines(caneca, ["cor"])).toEqual(esperado);
  });

  it("singular de 'disponível' no produto sem variação; lista vazia não gera linha", () => {
    expect(formatVariantLines([variante("X", {}, 1, 1000)], [])).toEqual([
      `• ${formatCentsBRL(1000)} (1 disponível) — SKU: X`,
    ]);
    expect(formatVariantLines([], POLO_AXES)).toEqual([]);
  });
});

describe("buildVariantMenu", () => {
  it("uma linha por combinação DISPONÍVEL, dentro dos limites da Z-API", () => {
    const menu = buildVariantMenu("Camisa Polo", POLO, POLO_AXES);
    expect(menu).not.toBeNull();
    expect(menu?.message).toBe("Toque abaixo para escolher cor e tamanho 👇");
    expect(menu?.title).toBe("Camisa Polo");
    expect(menu?.options).toEqual([
      {
        id: "variante:POLO-VD-P",
        title: "Verde · P",
        description: `${formatCentsBRL(8990)} · 3 disponíveis`,
      },
      {
        id: "variante:POLO-VD-G",
        title: "Verde · G",
        description: `${formatCentsBRL(8990)} · 2 disponíveis`,
      },
      {
        id: "variante:POLO-AM-M",
        title: "Amarelo · M",
        description: `${formatCentsBRL(8990)} · 1 disponível`,
      },
    ]);
  });

  it("corta o título em 24 caracteres (limite da lista da Z-API)", () => {
    const menu = buildVariantMenu(
      "Camisa",
      [variante("X", { cor: "Verde Militar Desbotado", tamanho: "GG" }, 1)],
      POLO_AXES,
    );
    const titulo = menu?.options[0].title ?? "";
    expect(titulo.length).toBeLessThanOrEqual(24);
    expect(titulo.endsWith("…")).toBe(true);
  });

  it("null quando não cabe menu honesto: sem variação, tudo esgotado ou mais de 10", () => {
    expect(buildVariantMenu("Caneca", [variante("C", {}, 5)], [])).toBeNull();
    expect(
      buildVariantMenu(
        "Camisa Polo",
        POLO.map((v) => ({ ...v, availableQty: 0 })),
        POLO_AXES,
      ),
    ).toBeNull();
    // 11 combinações: truncar esconderia opções que existem de verdade.
    const onze = Array.from({ length: 11 }, (_, i) =>
      variante(`SKU-${i}`, { cor: "Verde", tamanho: `T${i}` }, 1),
    );
    expect(buildVariantMenu("Camisa Polo", onze, POLO_AXES)).toBeNull();
  });

  it("null quando um id passaria de 64 caracteres", () => {
    const skuEnorme = "S".repeat(60);
    expect(
      buildVariantMenu(
        "Camisa Polo",
        [variante(skuEnorme, { cor: "Verde", tamanho: "P" }, 1)],
        POLO_AXES,
      ),
    ).toBeNull();
  });
});

describe("pickImagePath / colorOfVariant", () => {
  const imagens = [
    { path: "polo/geral-full.webp", color: null },
    { path: "polo/verde-full.webp", color: "Verde" },
    { path: "polo/amarelo-full.webp", color: "Amarelo" },
  ];

  it("manda a foto da cor escolhida", () => {
    expect(pickImagePath(imagens, "Amarelo")).toBe("polo/amarelo-full.webp");
    // A comparação normaliza: "verde" e "Verde" são a mesma cor.
    expect(pickImagePath(imagens, "verde")).toBe("polo/verde-full.webp");
  });

  it("sem foto da cor, cai na genérica; sem genérica, na primeira", () => {
    expect(pickImagePath(imagens, "Preto")).toBe("polo/geral-full.webp");
    const soColoridas = imagens.slice(1);
    expect(pickImagePath(soColoridas, "Preto")).toBe("polo/verde-full.webp");
  });

  it("sem cor definida usa a primeira; sem imagem devolve null", () => {
    expect(pickImagePath(imagens, null)).toBe("polo/geral-full.webp");
    expect(pickImagePath(imagens, "  ")).toBe("polo/geral-full.webp");
    expect(pickImagePath([], "Verde")).toBeNull();
  });

  it("colorOfVariant lê o PRIMEIRO eixo, que é o que product_images.color pareia", () => {
    expect(colorOfVariant({ cor: "Verde", tamanho: "P" }, POLO_AXES)).toBe(
      "Verde",
    );
    expect(colorOfVariant({ cor: "Verde", tamanho: "P" }, ["tamanho", "cor"])).toBe(
      "P",
    );
    expect(colorOfVariant({}, [])).toBeNull();
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
