// Definições das ferramentas do bot de vendas (contrato compartilhado da onda).
// A IA nunca é fonte de fatos: preço/estoque/frete/pedido vêm destas ferramentas,
// que devolvem blocos de texto pt-BR prontos para o modelo retransmitir.

import { z } from "zod";

export const BOT_TOOL_NAMES = [
  "listar_produtos",
  "detalhar_produto",
  "cotar_frete",
  "buscar_cadastro",
  "criar_pedido",
  "status_do_pedido",
  "enviar_chave_pix",
  "avisar_dono",
  "transferir_para_atendente",
] as const;

export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

export type BotToolDefinition = {
  name: BotToolName;
  description: string;
  input_schema: Record<string, unknown>;
};

export type BotToolInputs = {
  listar_produtos: { busca?: string };
  detalhar_produto: { produto: string; cor?: string };
  cotar_frete: { cep: string };
  buscar_cadastro: Record<string, never>;
  criar_pedido: {
    itens: { sku: string; quantidade: number }[];
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
  transferir_para_atendente: { motivo: string };
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

export const BOT_TOOLS: readonly BotToolDefinition[] = [
  {
    name: "listar_produtos",
    description:
      "Lista o catálogo ativo da loja com nomes e preços reais E envia ao cliente um menu interativo com botões. Chame SEMPRE que o cliente quiser ver/escolher produtos — inclusive 'quero ver outro produto' e mesmo que a lista já tenha aparecido na conversa (só a chamada envia o menu). Passe busca para filtrar por nome; sem busca, devolve o catálogo completo.",
    input_schema: {
      type: "object",
      properties: {
        busca: {
          type: "string",
          description:
            "Termo para filtrar produtos por nome (ex.: 'camiseta'). Omita para listar tudo.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "detalhar_produto",
    description:
      "Devolve detalhes de um produto: cores e tamanhos disponíveis, estoque, preço exato e o SKU de cada combinação, E envia ao cliente a foto e (quando cabem até 10) um menu tocável com as variações. Chame SEMPRE antes de adicionar um item ao pedido, para confirmar SKU, preço e estoque. Passe cor quando o cliente já tiver dito a cor: a foto enviada passa a ser a daquela cor.",
    input_schema: {
      type: "object",
      properties: {
        produto: {
          type: "string",
          description: "Nome do produto ou SKU exato.",
        },
        cor: {
          type: "string",
          description:
            "Cor que o cliente já escolheu nesta conversa (ex.: 'Verde'). Omita se ele ainda não disse a cor.",
        },
      },
      required: ["produto"],
      additionalProperties: false,
    },
  },
  {
    name: "cotar_frete",
    description:
      "Devolve as opções reais de entrega (transportadora, prazo e valor) para o CEP do cliente, considerando os itens já escolhidos nesta conversa. Só chame depois de o cliente escolher os itens. Passe apenas o CEP.",
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
      "Procura o cadastro já salvo do cliente DESTA conversa (nome, CPF e endereço da última compra). Chame ANTES de começar a pedir dados pessoais: se o cliente já comprou, você confirma tudo em uma pergunta em vez de coletar sete campos. Devolve o CPF mascarado de propósito — os dados reais nunca passam por você.",
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
      "Cria o pedido REAL com reserva de estoque e devolve o resumo oficial + LINK DE PAGAMENTO. Só chame após confirmar com o cliente TODOS os dados (itens, quantidades, dados pessoais, endereço e frete) e receber o SIM. O resumo devolvido é a única fonte de valores — retransmita sem alterar. TELEFONE: o pedido usa automaticamente o número de WhatsApp desta conversa — NUNCA peça telefone ao cliente.",
    input_schema: {
      type: "object",
      properties: {
        itens: {
          type: "array",
          minItems: 1,
          description: "Itens confirmados pelo cliente.",
          items: {
            type: "object",
            properties: {
              sku: {
                type: "string",
                description: "SKU exato confirmado via detalhar_produto.",
              },
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
        usar_cadastro_salvo: {
          type: "boolean",
          default: false,
          description:
            "true reaproveita nome, CPF e endereço já salvos deste telefone — o serviço lê os dados do banco, então NÃO envie nome_completo, cpf nem endereço. Só use depois de buscar_cadastro e do cliente CONFIRMAR que os dados estão certos. Se ele quiser mudar algo, omita este campo e envie todos os dados normalmente.",
        },
        nome_completo: {
          type: "string",
          description:
            "Nome completo do cliente. Obrigatório, exceto quando usar_cadastro_salvo for true.",
        },
        cpf: {
          type: "string",
          description:
            "CPF do cliente, somente os 11 dígitos, sem pontos ou traço (ex.: '12345678901'). Necessário para a nota fiscal.",
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
          description: "Código de cupom informado pelo cliente. Omita se não houver.",
        },
        forma_de_pagamento: {
          type: "string",
          enum: ["online", "dinheiro_na_entrega"],
          default: "online",
          description:
            "Use 'dinheiro_na_entrega' SOMENTE quando o cliente pedir explicitamente para pagar em dinheiro na entrega. Caso contrário, omita: o padrão é 'online' (link de pagamento).",
        },
        telefone: {
          type: "string",
          description:
            "IGNORADO — o pedido sempre usa o número de WhatsApp da própria conversa. Não peça telefone ao cliente; omita este campo.",
        },
      },
      // Só 'itens' é sempre obrigatório: com usar_cadastro_salvo os dados
      // pessoais vêm do banco. A exigência real (ou o cadastro salvo, ou o
      // conjunto completo de campos) é validada em criarPedidoSchema, que é
      // quem barra de fato — o JSON schema aqui só orienta o modelo.
      required: ["itens"],
      additionalProperties: false,
    },
  },
  {
    name: "status_do_pedido",
    description:
      "Devolve o status atual e o rastreio do pedido do cliente desta conversa. Passe numero_do_pedido se o cliente informar; omita para usar o pedido mais recente da conversa.",
    input_schema: {
      type: "object",
      properties: {
        numero_do_pedido: {
          type: "integer",
          description:
            "Número do pedido informado pelo cliente. Omita para o pedido mais recente.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "enviar_chave_pix",
    description:
      "Envia a chave Pix da loja para o cliente pagar por transferência manual quando houver problema com o link. SÓ oferece se a ferramenta confirmar disponibilidade; o dono confirma o recebimento manualmente.",
    input_schema: {
      type: "object",
      properties: {
        numero_do_pedido: {
          type: "integer",
          minimum: 1,
          description:
            "Número do pedido a pagar, se o cliente informar. Omita para usar o pedido mais recente da conversa.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "avisar_dono",
    description:
      "Envia um aviso interno ao dono da loja. Use APENAS para fatos que exigem ação dele — ex.: cliente informa que fez o Pix. Nunca para conversa comum.",
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
    name: "transferir_para_atendente",
    description:
      "Passa a conversa para o atendente humano e encerra a sua participação. Use quando o cliente pedir para falar com uma pessoa, quando você não conseguir ajudar após 2 tentativas, ou em reclamação, troca ou reembolso.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          description:
            "Resumo curto do motivo da transferência, para o atendente ler.",
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
  }),
  detalhar_produto: z.strictObject({
    produto: z.string().min(1),
    cor: z.string().min(1).optional(),
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
      .min(1),
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
  transferir_para_atendente: z.strictObject({
    motivo: z.string().min(1),
  }),
};
