// Definições das ferramentas da vendedora do WhatsApp (contrato compartilhado).
// A IA nunca é fonte de fatos: preço/estoque/frete/pedido vêm destas
// ferramentas, que devolvem blocos de texto pt-BR prontos para o modelo
// retransmitir. Vocabulário da casa em toda descrição: catálogo, peça, look,
// sacola — nunca "menu".

import { z } from "zod";

export const BOT_TOOL_NAMES = [
  "listar_produtos",
  "detalhar_produto",
  "adicionar_a_sacola",
  "ver_sacola",
  "remover_da_sacola",
  "cotar_frete",
  "buscar_cadastro",
  "criar_pedido",
  "status_do_pedido",
  "enviar_chave_pix",
  "avisar_dono",
  "anotar",
  "transferir_para_atendente",
] as const;

export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

export type BotToolDefinition = {
  name: BotToolName;
  description: string;
  input_schema: Record<string, unknown>;
};

export type BotToolInputs = {
  listar_produtos: {
    busca?: string;
    categoria?: string;
    cor?: string;
    tamanho?: string;
    /** Teto de preço em reais inteiros; o executor converte para centavos. */
    preco_maximo_reais?: number;
    pagina?: number;
  };
  detalhar_produto: { produto: string; cor?: string };
  adicionar_a_sacola: { sku: string; quantidade: number };
  ver_sacola: Record<string, never>;
  remover_da_sacola: { sku: string };
  cotar_frete: { cep: string };
  buscar_cadastro: Record<string, never>;
  criar_pedido: {
    /** Omitido = fecha com o que está na sacola. */
    itens?: { sku: string; quantidade: number }[];
    /** Opção de frete que a cliente escolheu (nome ou número da cotação). */
    frete?: string;
    /**
     * Reaproveita nome, CPF e endereço já salvos deste telefone. Quando true,
     * os campos pessoais são OPCIONAIS: o serviço lê os dados reais do banco e
     * o CPF nunca passa pelo modelo. Só use após confirmar com o cliente via
     * buscar_cadastro.
     */
    usar_cadastro_salvo?: boolean;
    nome_completo?: string;
    cpf?: string;
    cep?: string;
    rua?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    cupom?: string;
    /** Aceito e ignorado — o pedido usa o telefone da conversa. */
    telefone?: string;
    /** Default 'online'; dinheiro só quando o cliente pedir explicitamente. */
    forma_de_pagamento?: "online" | "dinheiro_na_entrega";
  };
  status_do_pedido: { numero_do_pedido?: number };
  enviar_chave_pix: { numero_do_pedido?: number };
  avisar_dono: { mensagem: string };
  anotar: { nota: string };
  transferir_para_atendente: { motivo: string; resumo?: string };
};

/**
 * Executor de ferramenta fornecido pelos serviços: `text` é o bloco pt-BR
 * pronto devolvido ao modelo; `endsTurn: true` em transferir_para_atendente
 * (o adapter PARA o loop e não pede resposta final ao modelo).
 */
export type ToolExecutor = (
  name: BotToolName,
  input: unknown,
) => Promise<{ ok: boolean; text: string; endsTurn?: boolean }>;

const skuProperty = {
  type: "string",
  description: "SKU exato da combinação, como devolvido por detalhar_produto.",
};

export const BOT_TOOLS: readonly BotToolDefinition[] = [
  {
    name: "listar_produtos",
    description:
      "Busca peças no catálogo (nomes, preços reais e disponibilidade) E envia à cliente a lista tocável do catálogo com botões. Chame SEMPRE que a cliente quiser ver ou escolher peças — inclusive 'quero ver outra' e mesmo que uma lista já tenha aparecido antes (só a chamada envia os botões). Use os filtros para curar: categoria (ex.: 'vestidos'), cor, tamanho, preço máximo, busca por nome ou descrição. Cabem 10 peças por página; passe pagina para ver as próximas.",
    input_schema: {
      type: "object",
      properties: {
        busca: {
          type: "string",
          description:
            "Palavra que a cliente usou (ex.: 'linho', 'midi', 'festa'). Procura no nome e na descrição. Omita para não filtrar por texto.",
        },
        categoria: {
          type: "string",
          description:
            "Nome ou slug de uma categoria da PLANTA DA LOJA (ex.: 'vestidos'). Omita para todas.",
        },
        cor: {
          type: "string",
          description: "Só peças disponíveis nesta cor (ex.: 'Preto').",
        },
        tamanho: {
          type: "string",
          description: "Só peças disponíveis neste tamanho (ex.: 'M', '40').",
        },
        preco_maximo_reais: {
          type: "integer",
          minimum: 1,
          description: "Teto de preço em reais (ex.: 300 = até R$ 300,00).",
        },
        pagina: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "Página da lista (10 peças por página). Padrão 1.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "detalhar_produto",
    description:
      "Devolve tudo sobre uma peça: descrição completa (tecido, caimento, medidas quando o dono cadastrou), categoria, cores e tamanhos com estoque, preço exato (e preço 'de/por' quando houver promoção) e o SKU de cada combinação — E envia à cliente a foto e, quando cabem até 10, a lista tocável de cores e tamanhos. Chame SEMPRE antes de adicionar à sacola. Passe cor quando a cliente já disse a cor: a foto passa a ser a daquela cor. Se houver mais de uma peça com o nome, a ferramenta devolve as candidatas para você perguntar qual.",
    input_schema: {
      type: "object",
      properties: {
        produto: {
          type: "string",
          description: "Nome da peça, slug (produto:<slug>) ou SKU exato.",
        },
        cor: {
          type: "string",
          description:
            "Cor que a cliente já escolheu nesta conversa (ex.: 'Verde'). Omita se ela ainda não disse.",
        },
      },
      required: ["produto"],
      additionalProperties: false,
    },
  },
  {
    name: "adicionar_a_sacola",
    description:
      "Coloca uma combinação (SKU) na sacola desta conversa, conferindo preço e estoque na hora. É a memória oficial do que a cliente vai levar: cotar_frete usa o peso real da sacola e criar_pedido fecha com ela. Chame assim que a cliente confirmar cor e tamanho de uma peça.",
    input_schema: {
      type: "object",
      properties: {
        sku: skuProperty,
        quantidade: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "Quantidade (inteiro, mínimo 1). Padrão 1.",
        },
      },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "ver_sacola",
    description:
      "Mostra o que está na sacola desta conversa, com preços atuais e subtotal. Use antes do resumo final ou quando a cliente perguntar o que já escolheu.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "remover_da_sacola",
    description: "Tira uma combinação (SKU) da sacola desta conversa.",
    input_schema: {
      type: "object",
      properties: { sku: skuProperty },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "cotar_frete",
    description:
      "Devolve as opções reais de entrega (transportadora, prazo e valor) para o CEP da cliente, com o peso das peças que estão na sacola. Chame depois de montar a sacola. A cliente ESCOLHE uma das opções; passe a escolha em criar_pedido (campo frete).",
    input_schema: {
      type: "object",
      properties: {
        cep: {
          type: "string",
          description: "CEP de entrega, somente os 8 dígitos (ex.: '01310100').",
          pattern: "^[0-9]{8}$",
        },
      },
      required: ["cep"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_cadastro",
    description:
      "Procura o cadastro já salvo da cliente DESTA conversa (nome, CPF e endereço da última compra). Chame ANTES de começar a pedir dados pessoais: se ela já comprou, você confirma tudo em uma pergunta em vez de coletar sete campos. Devolve o CPF mascarado de propósito — os dados reais nunca passam por você.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "criar_pedido",
    description:
      "Cria o pedido REAL com reserva de estoque e devolve o resumo oficial + LINK DE PAGAMENTO. Só chame após a cliente ler o resumo (peças, quantidades, dados pessoais, endereço e frete) e dizer SIM. Sem 'itens', fecha com a sacola desta conversa. O resumo devolvido é a única fonte de valores — retransmita sem alterar. TELEFONE: o pedido usa automaticamente o número desta conversa — NUNCA peça telefone.",
    input_schema: {
      type: "object",
      properties: {
        itens: {
          type: "array",
          minItems: 1,
          description:
            "Omita para usar a sacola. Só passe quando quiser fechar com outra combinação de peças.",
          items: {
            type: "object",
            properties: {
              sku: skuProperty,
              quantidade: {
                type: "integer",
                minimum: 1,
                description: "Quantidade do item (inteiro, mínimo 1).",
              },
            },
            required: ["sku", "quantidade"],
            additionalProperties: false,
          },
        },
        frete: {
          type: "string",
          description:
            "A opção de entrega que a cliente escolheu entre as de cotar_frete — o nome (ex.: 'SEDEX') ou o número da opção (ex.: '2'). Omita só se houver uma única opção.",
        },
        usar_cadastro_salvo: {
          type: "boolean",
          default: false,
          description:
            "true reaproveita nome, CPF e endereço já salvos deste telefone — o serviço lê os dados do banco, então NÃO envie nome_completo, cpf nem endereço. Só use depois de buscar_cadastro e da cliente CONFIRMAR que os dados estão certos. Se ela quiser mudar algo, omita este campo e envie todos os dados normalmente.",
        },
        nome_completo: {
          type: "string",
          description:
            "Nome completo da cliente. Obrigatório, exceto quando usar_cadastro_salvo for true.",
        },
        cpf: {
          type: "string",
          description:
            "CPF da cliente, somente os 11 dígitos, sem pontos ou traço (ex.: '12345678901'). Necessário para a nota fiscal.",
          pattern: "^[0-9]{11}$",
        },
        cep: {
          type: "string",
          description: "CEP de entrega, somente os 8 dígitos (ex.: '01310100').",
          pattern: "^[0-9]{8}$",
        },
        rua: { type: "string", description: "Logradouro (rua/avenida)." },
        numero: {
          type: "string",
          description: "Número do endereço (texto; aceita 's/n').",
        },
        complemento: {
          type: "string",
          description: "Complemento do endereço (apto, bloco). Omita se não houver.",
        },
        bairro: { type: "string", description: "Bairro." },
        cidade: { type: "string", description: "Cidade." },
        uf: {
          type: "string",
          description: "Sigla do estado com 2 letras (ex.: 'SP').",
          pattern: "^[A-Za-z]{2}$",
        },
        cupom: {
          type: "string",
          description: "Código de cupom informado pela cliente. Omita se não houver.",
        },
        forma_de_pagamento: {
          type: "string",
          enum: ["online", "dinheiro_na_entrega"],
          default: "online",
          description:
            "Use 'dinheiro_na_entrega' SOMENTE quando a cliente pedir explicitamente para pagar em dinheiro na entrega. Caso contrário, omita: o padrão é 'online' (link de pagamento).",
        },
        telefone: {
          type: "string",
          description:
            "IGNORADO — o pedido sempre usa o número de WhatsApp da própria conversa. Não peça telefone; omita este campo.",
        },
      },
      // Nada é sempre obrigatório: os itens vêm da sacola e, com
      // usar_cadastro_salvo, os dados pessoais vêm do banco. A exigência real
      // (ou o cadastro salvo, ou o conjunto completo de campos) é validada em
      // criarPedidoSchema, que é quem barra de fato.
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "status_do_pedido",
    description:
      "Devolve o status atual e o rastreio do pedido da cliente desta conversa. Passe numero_do_pedido se ela informar; omita para usar o pedido mais recente.",
    input_schema: {
      type: "object",
      properties: {
        numero_do_pedido: {
          type: "integer",
          description:
            "Número do pedido informado pela cliente. Omita para o pedido mais recente.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "enviar_chave_pix",
    description:
      "Envia a chave Pix da loja para a cliente pagar por transferência manual quando houver problema com o link. SÓ ofereça se a ferramenta confirmar disponibilidade; o dono confirma o recebimento manualmente.",
    input_schema: {
      type: "object",
      properties: {
        numero_do_pedido: {
          type: "integer",
          minimum: 1,
          description:
            "Número do pedido a pagar, se a cliente informar. Omita para usar o pedido mais recente.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "avisar_dono",
    description:
      "Envia um aviso interno ao dono da loja. Use APENAS para fatos que exigem ação dele — ex.: cliente informa que fez o Pix; cliente quer ser avisada quando uma peça esgotada voltar. Nunca para conversa comum.",
    input_schema: {
      type: "object",
      properties: {
        mensagem: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description:
            "Texto curto do aviso (máximo 300 caracteres), com número do pedido e valor quando existirem.",
        },
      },
      required: ["mensagem"],
      additionalProperties: false,
    },
  },
  {
    name: "anotar",
    description:
      "Escreve no caderninho da vendedora um fato curto e útil para as próximas compras desta cliente: tamanho que usa, cores que ama ou evita, ocasião, para quem compra, peça esgotada que quer ser avisada. NUNCA anote CPF, endereço ou dado de pagamento. Uma frase por chamada.",
    input_schema: {
      type: "object",
      properties: {
        nota: {
          type: "string",
          minLength: 3,
          maxLength: 140,
          description: "Ex.: 'veste M em vestidos, prefere tons terrosos'.",
        },
      },
      required: ["nota"],
      additionalProperties: false,
    },
  },
  {
    name: "transferir_para_atendente",
    description:
      "Passa a conversa para a equipe da loja e encerra a sua participação. Use quando a cliente pedir para falar com uma pessoa, quando você não conseguir ajudar após 2 tentativas, ou em reclamação, troca, defeito ou reembolso. Passe um resumo de 3 linhas para a equipe não perguntar nada de novo.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          description: "Motivo curto da transferência (ex.: 'quer trocar o tamanho').",
        },
        resumo: {
          type: "string",
          maxLength: 600,
          description:
            "Até 3 linhas: o que a cliente quer, tamanho/orçamento/peças já mostradas, e o que ficou pendente.",
        },
      },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
];

// Validação de runtime (source of truth) usada pelo executor antes de agir.
// Máscaras comuns ("01310-100", "390.533.447-05") são aceitas e normalizadas:
// o modelo tende a repassar o que o cliente digitou, e recusar por pontuação
// só alonga a conversa sem proteger nada.
const digitos = (tamanho: number, rotulo: string) =>
  z
    .string()
    .transform((valor) => valor.replace(/\D/g, ""))
    .pipe(
      z
        .string()
        .regex(
          new RegExp(`^[0-9]{${tamanho}}$`),
          `${rotulo} deve ter ${tamanho} dígitos`,
        ),
    );

export const BOT_TOOL_INPUT_SCHEMAS: Record<BotToolName, z.ZodType> = {
  listar_produtos: z.strictObject({
    busca: z.string().optional(),
    categoria: z.string().optional(),
    cor: z.string().optional(),
    tamanho: z.string().optional(),
    preco_maximo_reais: z.number().int().min(1).optional(),
    pagina: z.number().int().min(1).default(1),
  }),
  detalhar_produto: z.strictObject({
    produto: z.string().min(1),
    cor: z.string().min(1).optional(),
  }),
  adicionar_a_sacola: z.strictObject({
    sku: z.string().min(1),
    quantidade: z.number().int().min(1).max(20).default(1),
  }),
  ver_sacola: z.strictObject({}),
  remover_da_sacola: z.strictObject({
    sku: z.string().min(1),
  }),
  cotar_frete: z.strictObject({
    cep: digitos(8, "CEP"),
  }),
  criar_pedido: z.strictObject({
    itens: z
      .array(
        z.strictObject({
          sku: z.string().min(1),
          quantidade: z.number().int().min(1),
        }),
      )
      .min(1)
      .optional(),
    frete: z.string().optional(),
    usar_cadastro_salvo: z.boolean().default(false),
    nome_completo: z.string().min(1).optional(),
    cpf: digitos(11, "CPF").optional(),
    cep: digitos(8, "CEP").optional(),
    rua: z.string().min(1).optional(),
    numero: z.string().min(1).optional(),
    complemento: z.string().optional(),
    bairro: z.string().min(1).optional(),
    cidade: z.string().min(1).optional(),
    uf: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "UF deve ter 2 letras")
      .optional(),
    cupom: z.string().optional(),
    // Aceito e IGNORADO: o pedido usa o telefone da própria conversa. O
    // modelo tende a coletar telefone por instinto de vendedor — rejeitar o
    // campo travava a finalização (caso real em produção, 2026-08-26).
    telefone: z.string().optional(),
    forma_de_pagamento: z
      .enum(["online", "dinheiro_na_entrega"])
      .default("online"),
  })
    // Ou o pedido reaproveita o cadastro salvo, ou traz o conjunto COMPLETO de
    // dados pessoais. Meio-termo produziria pedido sem endereço de entrega.
    .superRefine((valor, ctx) => {
      if (valor.usar_cadastro_salvo) return;
      const obrigatorios = [
        "nome_completo",
        "cpf",
        "cep",
        "rua",
        "numero",
        "bairro",
        "cidade",
        "uf",
      ] as const;
      for (const campo of obrigatorios) {
        if (valor[campo] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [campo],
            message: `Informe ${campo.replace(/_/g, " ")} — ou use usar_cadastro_salvo se o cliente confirmou o cadastro.`,
          });
        }
      }
    }),
  buscar_cadastro: z.strictObject({}),
  status_do_pedido: z.strictObject({
    numero_do_pedido: z.number().int().min(1).optional(),
  }),
  enviar_chave_pix: z.strictObject({
    numero_do_pedido: z.number().int().min(1).optional(),
  }),
  avisar_dono: z.strictObject({
    mensagem: z.string().min(1).max(300),
  }),
  anotar: z.strictObject({
    nota: z.string().trim().min(3).max(140),
  }),
  transferir_para_atendente: z.strictObject({
    motivo: z.string().min(1),
    resumo: z.string().trim().max(600).optional(),
  }),
};
