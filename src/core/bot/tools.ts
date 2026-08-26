// Definições das ferramentas do bot de vendas (contrato compartilhado da onda).
// A IA nunca é fonte de fatos: preço/estoque/frete/pedido vêm destas ferramentas,
// que devolvem blocos de texto pt-BR prontos para o modelo retransmitir.

import { z } from "zod";

export const BOT_TOOL_NAMES = [
  "listar_produtos",
  "detalhar_produto",
  "cotar_frete",
  "criar_pedido",
  "status_do_pedido",
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
  detalhar_produto: { produto: string };
  cotar_frete: { cep: string };
  criar_pedido: {
    itens: { sku: string; quantidade: number }[];
    nome_completo: string;
    cpf: string;
    cep: string;
    rua: string;
    numero: string;
    complemento?: string;
    bairro: string;
    cidade: string;
    uf: string;
    cupom?: string;
  };
  status_do_pedido: { numero_do_pedido?: number };
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
      "Lista o catálogo ativo da loja com nomes e preços reais. Use antes de recomendar qualquer produto. Passe busca para filtrar por nome; sem busca, devolve o catálogo completo.",
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
      "Devolve detalhes de um produto: variações/tamanhos, estoque disponível e preço exato. Chame SEMPRE antes de adicionar um item ao pedido, para confirmar SKU, preço e estoque.",
    input_schema: {
      type: "object",
      properties: {
        produto: {
          type: "string",
          description: "Nome do produto ou SKU exato.",
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
    name: "criar_pedido",
    description:
      "Cria o pedido REAL com reserva de estoque e devolve o resumo oficial + LINK DE PAGAMENTO. Só chame após confirmar com o cliente TODOS os dados (itens, quantidades, dados pessoais, endereço e frete) e receber o SIM. O resumo devolvido é a única fonte de valores — retransmita sem alterar.",
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
        nome_completo: {
          type: "string",
          description: "Nome completo do cliente.",
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
      },
      required: [
        "itens",
        "nome_completo",
        "cpf",
        "cep",
        "rua",
        "numero",
        "bairro",
        "cidade",
        "uf",
      ],
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
    nome_completo: z.string().min(1),
    cpf: digitos(11, "CPF"),
    cep: digitos(8, "CEP"),
    rua: z.string().min(1),
    numero: z.string().min(1),
    complemento: z.string().optional(),
    bairro: z.string().min(1),
    cidade: z.string().min(1),
    uf: z.string().regex(/^[A-Za-z]{2}$/, "UF deve ter 2 letras"),
    cupom: z.string().optional(),
  }),
  status_do_pedido: z.strictObject({
    numero_do_pedido: z.number().int().min(1).optional(),
  }),
  transferir_para_atendente: z.strictObject({
    motivo: z.string().min(1),
  }),
};
