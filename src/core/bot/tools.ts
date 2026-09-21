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
  "validar_cupom",
  "cotar_frete",
  "buscar_cadastro",
  "historico_de_compras",
  "criar_pedido",
  "status_do_pedido",
  "confirmar_entrega",
  "enviar_chave_pix",
  "avisar_dono",
  "reservar_peca",
  "liberar_reserva",
  "avisar_quando_voltar",
  "atualizar_cartela",
  "sugerir_tamanho",
  "enviar_nota_da_curadora",
  "montar_look",
  "oferecer_gentileza",
  "anotar",
  "registrar_foto_com_a_peca",
  "identificar_peca_na_foto",
  "retirar_minha_foto",
  "agendar_retorno",
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
    /** Nome ou slug de uma Edição de Belém (ex.: 'cirio'): só as peças da edição. */
    edicao?: string;
    cor?: string;
    tamanho?: string;
    /** Teto de preço em reais inteiros; o executor converte para centavos. */
    preco_maximo_reais?: number;
    pagina?: number;
  };
  detalhar_produto: { produto: string; cor?: string };
  adicionar_a_sacola: { sku: string; quantidade?: number };
  ver_sacola: Record<string, never>;
  remover_da_sacola: { sku: string };
  /** Código como a cliente escreveu; o executor normaliza e calcula sobre a sacola. */
  validar_cupom: { cupom: string };
  /** entregar_ate: data marcada da cliente (AAAA-MM-DD) — cada opção diz se chega; ocasiao só com entregar_ate. */
  cotar_frete: { cep: string; entregar_ate?: string; ocasiao?: string };
  buscar_cadastro: Record<string, never>;
  historico_de_compras: Record<string, never>;
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
    /** Data marcada ("preciso até dia 16", AAAA-MM-DD) e a ocasião — a loja prioriza a saída. */
    entregar_ate?: string;
    ocasiao?: string;
    /** Aceito e ignorado — o pedido usa o telefone da conversa. */
    telefone?: string;
    /** Default 'online'; dinheiro só quando o cliente pedir explicitamente. */
    forma_de_pagamento?: "online" | "dinheiro_na_entrega";
    /** Só quando a cliente disser que é presente: para quem e o bilhete DELA. */
    presente?: { para: string; bilhete?: string; entregar_ate?: string };
  };
  status_do_pedido: { numero_do_pedido?: number };
  /** A cliente disse que o pedido chegou: o pedido enviado vira entregue. */
  confirmar_entrega: { numero_do_pedido?: number };
  enviar_chave_pix: { numero_do_pedido?: number };
  avisar_dono: { mensagem: string };
  reservar_peca: { sku: string; quantidade?: number };
  liberar_reserva: Record<string, never>;
  avisar_quando_voltar: { sku: string };
  atualizar_cartela: {
    tamanhos?: { vestido?: string; blusa?: string; calca?: string };
    cores_ama?: string[];
    cores_evita?: string[];
    caimento?: "justo" | "fluido" | "tanto_faz";
    ocasioes?: ("trabalho" | "dia_a_dia" | "festa" | "casamento" | "viagem" | "praia" | "jantar")[];
    compra_para?: "mim" | "presente" | "os_dois";
    /** Medidas do corpo em cm (40–200) — ficam em coluna própria, nunca no histórico. */
    medidas?: { busto_cm?: number; cintura_cm?: number; quadril_cm?: number; apagar?: true };
  };
  /** "Será que o M me serve?": a folga em cm por tamanho e a recomendação, pelas medidas da cartela. */
  sugerir_tamanho: { produto: string };
  /** A voz da curadora sobre a peça vai para o WhatsApp dela como mensagem de voz. */
  enviar_nota_da_curadora: { produto: string; reenviar?: true };
  montar_look: { produto: string; orcamento_reais?: number };
  anotar: { nota: string };
  oferecer_gentileza: { motivo: string };
  /** A foto que ela acabou de mandar usando a peça: vira cartão e pedido de consentimento. */
  /** `foto` = qual das fotos recentes dela (1 = a primeira, 2 = a segunda…); omitida = a última. */
  registrar_foto_com_a_peca: { produto: string; foto?: number };
  /** Qual peça do catálogo aparece na foto que ela mandou (foto da loja repassada); categoria/cor/busca afunilam a comparação visual. */
  identificar_peca_na_foto: { foto?: number; categoria?: string; cor?: string; busca?: string };
  retirar_minha_foto: Record<string, never>;
  /** Só depois do SIM dela à pergunta "posso te chamar …?". Data/hora no relógio de São Paulo. */
  agendar_retorno: { data: string; hora: string; motivo: string; cliente_autorizou: true };
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
      "Busca peças no catálogo (nomes, preços reais e disponibilidade) E envia à cliente a lista tocável do catálogo com botões. Chame SEMPRE que a cliente quiser ver ou escolher peças — inclusive 'quero ver outra' e mesmo que uma lista já tenha aparecido antes (só a chamada envia os botões). Use os filtros para curar: categoria (ex.: 'vestidos'), cor, tamanho, preço máximo, busca por nome ou descrição. Sem pagina, manda o catálogo inteiro de uma vez, em até 3 listas de 10 (o WhatsApp só aceita 10 por lista); o resultado diz se ficou alguma peça de fora — só então passe pagina para as próximas.",
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
            "Categoria (ex.: 'vestuario', 'acessorios') OU tipo de peça (ex.: 'vestido', 'corset', 'bolsa') da PLANTA DA LOJA. Omita para todas.",
        },
        edicao: {
          type: "string",
          description:
            "Nome ou slug de uma Edição de Belém da PLANTA DA LOJA (ex.: 'edicao-cirio'): só as peças escolhidas para aquela ocasião. Use quando a cliente citar a ocasião (Círio, Natal…). Omita para todas.",
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
          description: "Só quando o resultado disser que há mais peças: a página seguinte (10 por página). Sem pagina, vai o catálogo inteiro em até 3 listas.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "detalhar_produto",
    description:
      "Devolve tudo sobre uma peça: descrição completa, ficha (composição, cuidados, como veste) e tabela de medidas por tamanho em cm quando a loja cadastrou, categoria, cores e tamanhos com estoque, preço exato (e preço 'de/por' quando houver promoção) e o SKU de cada combinação — E envia à cliente a foto e, quando cabem até 10, a lista tocável de cores e tamanhos. Chame SEMPRE antes de adicionar à sacola. Passe cor quando a cliente já disse a cor: a foto passa a ser a daquela cor. Se houver mais de uma peça com o nome, a ferramenta devolve as candidatas para você perguntar qual.",
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
          description: "Quantidade TOTAL desta peça na sacola (não soma): omita para 1; para mais unidades passe o total (ex.: 2). Chamar de novo com a peça já na sacola não muda nada.",
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
    description: "Tira uma peça da sacola desta conversa: pelo SKU (o [sku: …] que ver_sacola e o caderninho mostram) ou pelo NOME como aparece na sacola (ex.: 'Cropped Íris Suplex'). Se duas linhas servirem, a ferramenta lista e você escolhe.",
    input_schema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "O SKU da linha (o [sku: …] da sacola) ou o nome da peça como está na sacola.",
        },
      },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "validar_cupom",
    description:
      "Valida um cupom de desconto que a cliente mencionou e calcula o desconto REAL sobre a sacola atual — o valor sai daqui, nunca de cabeça. Chame assim que ela citar um código, com as peças já na sacola. Se for válido, passe o MESMO código em criar_pedido.cupom (o desconto só é aplicado ao fechar o pedido). Alguns cupons são de frete grátis (motoboy, Correios ou qualquer entrega), pessoais (só desta cliente), só para a primeira compra, uma vez por cliente, para algumas peças ou com dia e horário — a ferramenta diz o que vale. Se não for válido, diga o motivo devolvido e siga sem desconto: não existe outro desconto além do que esta ferramenta confirmar.",
    input_schema: {
      type: "object",
      properties: {
        cupom: {
          type: "string",
          description:
            "Código do cupom como a cliente escreveu (maiúsculas e minúsculas não importam).",
        },
      },
      required: ["cupom"],
      additionalProperties: false,
    },
  },
  {
    name: "cotar_frete",
    description:
      "Devolve as opções reais de entrega (transportadora, prazo e valor) para um CEP, com o peso das peças que estão na sacola — o motoboy vem como uma opção por janela de horário ('hoje, 19h–21h', com a hora-limite para pagar); onde o motoboy chega, só ele aparece. Fora da área do motoboy vêm PAC e SEDEX dos Correios (valor e prazo em dias úteis) quando a cotação automática está ligada; se a resposta disser que o frete é calculado pela equipe, siga a instrução devolvida (endereço → transferir_para_atendente), sem inventar valor. Chame depois de montar a sacola e SEMPRE com o CEP do endereço que VAI no pedido (o salvo que a cliente confirmou, ou o novo). Se o endereço ou a sacola mudar, cote de novo. Se a cliente disse até que dia precisa da peça, passe entregar_ate: cada opção volta com 'chega dia…' ou 'pode chegar só…'. A cliente ESCOLHE uma das opções; passe a escolha em criar_pedido (campo frete).",
    input_schema: {
      type: "object",
      properties: {
        cep: {
          type: "string",
          description: "CEP de entrega, somente os 8 dígitos (ex.: '01310100').",
          pattern: "^[0-9]{8}$",
        },
        entregar_ate: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Data marcada (AAAA-MM-DD), só se a cliente disse até que dia precisa da peça. Cada opção volta dizendo se chega a tempo. O caderninho diz que dia é hoje.",
        },
        ocasiao: {
          type: "string",
          maxLength: 60,
          description: "A ocasião da data marcada, como ela disse (ex.: 'aniversário da mãe'). Só com entregar_ate.",
        },
      },
      required: ["cep"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_cadastro",
    description:
      "Procura o cadastro já salvo da cliente DESTA conversa: nome, CPF mascarado e até 3 endereços salvos, cada um com o CEP. Chame ANTES de começar a pedir dados pessoais e ANTES de cotar o frete: confirme QUAL endereço é o da entrega e cote com o CEP dele. Se ela já comprou, você confirma tudo em uma pergunta em vez de coletar sete campos. O CPF vem mascarado de propósito — os dados reais nunca passam por você.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "historico_de_compras",
    description:
      "O que a cliente DESTA conversa já comprou na loja: os últimos pedidos com número, data, status e peças (nome, cor e tamanho). Use quando ela perguntar o que levou, quiser repetir uma peça ou o tamanho, pedir algo que combine com o que já tem, ou quando o caderninho mostrar 'Compras anteriores' e lembrar a peça ajudar a vender. Só enxerga os pedidos do telefone desta conversa — nunca de outra pessoa.",
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
      "Cria o pedido REAL com reserva de estoque e devolve o resumo oficial + LINK DE PAGAMENTO. Só chame após a cliente ler o resumo (peças, quantidades, dados pessoais, endereço e frete) e dizer SIM. Sem 'itens', fecha com a sacola desta conversa. Só fecha com o frete cotado NESTA conversa (cotar_frete) para o CEP do endereço de entrega, depois da última mudança na sacola — endereço com CEP diferente do cotado, cotação antiga ou frete que não é das opções cotadas devolvem ok:false: siga a instrução devolvida, mostre o resumo atualizado e espere um novo SIM. O resumo devolvido é a única fonte de valores — retransmita sem alterar. TELEFONE: o pedido usa automaticamente o número desta conversa — NUNCA peça telefone.",
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
            "A opção de entrega que a cliente escolheu — o nome ou o número EXATAMENTE como cotar_frete devolveu nesta conversa (ex.: 'SEDEX' ou '2'). Omita só se houver uma única opção. Nunca escreva um nome de frete que não veio de cotar_frete. Para o motoboy, é a janela (ex.: 'motoboy hoje 19h–21h' ou o número da opção).",
        },
        usar_cadastro_salvo: {
          type: "boolean",
          default: false,
          description:
            "true reaproveita nome e CPF já salvos deste telefone — o serviço lê os dados do banco, então NÃO envie nome_completo nem cpf. O endereço de entrega é o salvo cujo CEP foi cotado nesta conversa (por isso cote com o CEP do endereço que a cliente confirmou). Se a entrega for em OUTRO endereço, envie-o COMPLETO nos campos cep, rua, numero, bairro, cidade e uf junto com este true (endereço pela metade é recusado). Só use depois de buscar_cadastro e da cliente CONFIRMAR os dados.",
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
          description:
            'Código que validar_cupom confirmou nesta conversa. OMITIDO = aplica o cupom já validado (se houver). Para fechar SEM cupom mesmo tendo um validado, passe string vazia "".',
        },
        forma_de_pagamento: {
          type: "string",
          enum: ["online", "dinheiro_na_entrega"],
          default: "online",
          description:
            "Use 'dinheiro_na_entrega' SOMENTE quando a cliente pedir explicitamente para pagar em dinheiro na entrega. Caso contrário, omita: o padrão é 'online' (link de pagamento).",
        },
        entregar_ate: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Data marcada (AAAA-MM-DD): até que dia a cliente precisa da peça, só se ela disse. Use a mesma data passada em cotar_frete.",
        },
        ocasiao: {
          type: "string",
          maxLength: 60,
          description: "A ocasião da data marcada, como ela disse (ex.: 'aniversário da mãe', 'Círio'). Só com entregar_ate.",
        },
        presente: {
          type: "object",
          description:
            "SÓ quando a cliente disser que a compra é presente para outra pessoa. Para quem é e, se ela quiser, o bilhete com as palavras DELA (nunca escreva o bilhete por ela). O pacote vai sem preço e com o bilhete impresso.",
          properties: {
            para: {
              type: "string",
              maxLength: 80,
              description: "Nome de quem recebe, como a cliente disse (ex.: 'minha mãe', 'Ana').",
            },
            bilhete: {
              type: "string",
              maxLength: 280,
              description: "Texto do bilhete, palavra por palavra como ela ditou. Omita se ela não quiser bilhete.",
            },
            entregar_ate: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Evite: a data de entrega do presente vai em entregar_ate (cotar_frete e criar_pedido), que mostra se chega a tempo. Aqui é só informativo.",
            },
          },
          required: ["para"],
          additionalProperties: false,
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
    name: "confirmar_entrega",
    description:
      "A cliente disse que o pedido CHEGOU ('chegou', 'recebi', 'já está comigo'): marca o pedido enviado desta conversa como entregue. Passe numero_do_pedido se ela informar; omita para o último pedido enviado. Nunca chame por conta própria — só quando ela disser que recebeu.",
    input_schema: {
      type: "object",
      properties: {
        numero_do_pedido: {
          type: "integer",
          description: "Número do pedido informado pela cliente. Omita para o último pedido enviado.",
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
      "Envia um aviso interno ao dono da loja. Use APENAS para fatos que exigem ação dele — ex.: cliente informa que fez o Pix. Peça esgotada NÃO é caso de aviso ao dono: use avisar_quando_voltar. Nunca para conversa comum.",
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
    name: "reservar_peca",
    description:
      "Segura UMA combinação (SKU) para esta cliente por um prazo curto (padrão 24 h), sem pedido — a reserva gentil. Só chame quando ELA pedir para guardar/segurar a peça, com a combinação já confirmada por detalhar_produto. Vale uma reserva ativa por cliente e no máximo 2 unidades. A resposta diz até quando vale: repita esse prazo para ela.",
    input_schema: {
      type: "object",
      properties: {
        sku: skuProperty,
        quantidade: {
          type: "integer",
          minimum: 1,
          maximum: 2,
          default: 1,
          description: "1 ou 2 unidades.",
        },
      },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "liberar_reserva",
    description:
      "Libera a reserva gentil ativa desta cliente (ela desistiu ou quer guardar outra peça). Sem parâmetros.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "avisar_quando_voltar",
    description:
      "Registra que a cliente quer receber UMA mensagem no WhatsApp quando uma combinação esgotada (SKU) voltar ao estoque. Só com o sim dela. É o caminho certo para peça esgotada (não avise o dono).",
    input_schema: {
      type: "object",
      properties: { sku: skuProperty },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "atualizar_cartela",
    description:
      "Guarda na cartela de estilo desta cliente o que ela contou: tamanho por tipo de peça, cores que ama ou evita, caimento, ocasiões e para quem compra. Campos próprios (a vitrine e as próximas conversas usam); só passe o que ela disse agora — o resto é preservado. Não é anotação livre: para isso existe anotar.",
    input_schema: {
      type: "object",
      properties: {
        tamanhos: {
          type: "object",
          properties: {
            vestido: { type: "string", description: "Tamanho em vestidos (ex.: 'M', '40')." },
            blusa: { type: "string", description: "Tamanho em blusas/camisas." },
            calca: { type: "string", description: "Tamanho em calças/saias." },
          },
          additionalProperties: false,
        },
        cores_ama: { type: "array", items: { type: "string" }, maxItems: 8, description: "Cores que ela ama vestir." },
        cores_evita: { type: "array", items: { type: "string" }, maxItems: 8, description: "Cores que ela evita." },
        caimento: { type: "string", enum: ["justo", "fluido", "tanto_faz"] },
        ocasioes: {
          type: "array",
          items: { type: "string", enum: ["trabalho", "dia_a_dia", "festa", "casamento", "viagem", "praia", "jantar"] },
          maxItems: 7,
        },
        compra_para: { type: "string", enum: ["mim", "presente", "os_dois"] },
        medidas: {
          type: "object",
          description: "Medidas do corpo que ELA contou agora, em centímetros (40–200). Nunca invente nem estime pela foto.",
          properties: {
            busto_cm: { type: "number", description: "Contorno do busto em cm." },
            cintura_cm: { type: "number", description: "Contorno da cintura em cm." },
            quadril_cm: { type: "number", description: "Contorno do quadril em cm." },
            apagar: { type: "boolean", enum: [true], description: "true quando ela pedir para apagar as medidas guardadas." },
          },
          additionalProperties: false,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "sugerir_tamanho",
    description:
      "Ela pergunta se um tamanho serve ('o M me serve?', 'qual tamanho eu pego?'): compara as medidas do corpo guardadas na cartela com a tabela da peça e devolve como cada tamanho fica (folga em cm) e o recomendado. Sem medidas na cartela, a ferramenta diz — aí pergunte busto, cintura e quadril em cm e guarde com atualizar_cartela.medidas antes de chamar de novo. Fale em folga (centímetros que sobram), nunca repita as medidas do corpo dela.",
    input_schema: {
      type: "object",
      properties: {
        produto: { type: "string", description: "Nome, slug ou SKU da peça (o mesmo de detalhar_produto)." },
      },
      required: ["produto"],
      additionalProperties: false,
    },
  },
  {
    name: "enviar_nota_da_curadora",
    description:
      "Manda à cliente, como mensagem de voz no WhatsApp (logo depois da sua resposta), a nota em áudio que a curadora gravou sobre a peça (tecido, caimento, calor). Chame quando detalhar_produto disser que a peça tem nota em áudio e a cliente perguntar de tecido, caimento ou calor — ou pedir para ouvir. Uma vez por peça na conversa; 'reenviar' só quando ela pedir de novo (no máximo mais uma). Se a ferramenta disser que o áudio vai, apresente em 1 frase ('a curadora gravou uma nota sobre ela — segue a voz dela') sem citar nem resumir a nota; se disser que não há áudio, responda com a nota escrita ou com o que a ficha diz.",
    input_schema: {
      type: "object",
      properties: {
        produto: { type: "string", description: "Nome, slug ou SKU da peça (o mesmo de detalhar_produto)." },
        reenviar: { type: "boolean", enum: [true], description: "Só quando a cliente pedir para ouvir de novo." },
      },
      required: ["produto"],
      additionalProperties: false,
    },
  },
  {
    name: "montar_look",
    description:
      "Monta o look completo a partir de UMA peça: escolhe 1 ou 2 complementos reais do catálogo (categoria diferente e que combina, com foto e estoque, preço na vizinhança) e envia à cliente o cartão do look em imagem. Chame UMA vez, depois do pedido fechado ou quando ela perguntar o que combina/como usar. Nunca invente combinação fora do que a ferramenta devolveu.",
    input_schema: {
      type: "object",
      properties: {
        produto: {
          type: "string",
          description: "Nome, slug ou SKU da peça principal (a que ela escolheu ou comprou).",
        },
        orcamento_reais: {
          type: "integer",
          minimum: 1,
          description: "Teto em reais para peça + complementos, se ela disse um orçamento.",
        },
      },
      required: ["produto"],
      additionalProperties: false,
    },
  },
  {
    name: "oferecer_gentileza",
    description:
      "Pede à loja uma GENTILEZA para esta cliente: um cupom pessoal, de poucos dias, sobre a sacola atual, dentro da cota diária da dona. Chame SÓ nas situações da seção GENTILEZAS do prompt — nunca na abertura, nunca sem peça na sacola, uma vez por conversa. A ferramenta confere tudo no servidor (cota do dia, compras anteriores, valor da sacola, tempo desde a última gentileza) e decide. ok: true devolve código, valor e validade — ofereça exatamente isso, ligado ao motivo. ok: false = não há gentileza hoje: NÃO mencione desconto, cupom nem que tentou. Nunca prometa antes de chamar.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          minLength: 3,
          maxLength: 140,
          description: "Por que agora, em poucas palavras (ex.: 'hesitou no preço do Longo Dunas'). Fica registrado para a dona.",
        },
      },
      required: ["motivo"],
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
    name: "registrar_foto_com_a_peca",
    description:
      "A cliente mandou há pouco uma foto DELA usando uma peça da loja que comprou (o caderninho diz o que ela comprou). Guarda a foto: ela recebe um cartão 'Ana veste …' e a pergunta se pode aparecer na página da peça — você NÃO pergunta nada disso. Passe o slug ou o nome exato da peça e, se ela mandou mais de uma foto, qual delas (foto: 1 = a primeira). Nunca chame para print do Instagram, foto de outra marca, peça no cabide, foto de outra pessoa ou foto sem a peça.",
    input_schema: {
      type: "object",
      properties: {
        produto: {
          type: "string",
          description: "Slug ou nome exato da peça que aparece na foto (o mesmo de detalhar_produto).",
        },
        foto: {
          type: "integer",
          minimum: 1,
          description: "Qual das fotos recentes dela: 1 = a primeira, 2 = a segunda… Omita para a última.",
        },
      },
      required: ["produto"],
      additionalProperties: false,
    },
  },
  {
    name: "identificar_peca_na_foto",
    description:
      "A cliente mandou há pouco uma foto que parece ser da própria loja — print do site ou do Instagram, foto com a etiqueta da loja, peça no flatlay. Confere contra as fotos do catálogo e diz QUAL peça aparece (pode ser mais de uma). Passe categoria e cor do que você vê para ajudar na comparação; foto = qual das fotos recentes (1 = a primeira; omita para a última). Depois responda à pergunta dela com detalhar_produto pelo slug devolvido. Cartão ou print com o NOME da peça escrito dispensa esta ferramenta: vá direto a detalhar_produto por esse nome. Não serve para foto DELA vestindo (use registrar_foto_com_a_peca) nem para peça de outra loja.",
    input_schema: {
      type: "object",
      properties: {
        foto: {
          type: "integer",
          minimum: 1,
          description: "Qual das fotos recentes dela: 1 = a primeira, 2 = a segunda… Omita para a última.",
        },
        categoria: {
          type: "string",
          description: "A categoria que você vê na foto (blusa, vestido, saia…), como na PLANTA DA LOJA.",
        },
        cor: {
          type: "string",
          description: "A cor principal da peça na foto.",
        },
        busca: {
          type: "string",
          description: "Palavra que ajude a achar candidatas (detalhe, estampa, nome que apareça escrito na foto).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "retirar_minha_foto",
    description:
      "A cliente pediu para tirar a foto dela da página da peça ('tira minha foto', 'não quero mais aparecer'): retira todas as fotos dela da vitrine na hora. Confirme em 1 frase.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "agendar_retorno",
    description:
      "Combina de VOCÊ chamar a cliente depois (ela adiou: 'me chama amanhã às 10', 'vou pensar'). SÓ chame depois de ela responder SIM à sua pergunta 'posso te chamar <quando>?' — nunca sem o sim explícito e nunca inventando a data. Horário entre 9h e 21h de São Paulo, de 30 minutos a 7 dias à frente. No horário a loja manda a mensagem por você.",
    input_schema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Dia do retorno no formato YYYY-MM-DD (calendário de São Paulo; o caderninho diz que dia é hoje)." },
        hora: { type: "string", description: "Hora no formato HH:MM, relógio de São Paulo (ex.: '10:00')." },
        motivo: { type: "string", minLength: 3, maxLength: 140, description: "O que retomar, em poucas palavras (ex.: 'ver se decidiu o Longo Dunas em M')." },
        cliente_autorizou: { type: "boolean", enum: [true], description: "true SÓ se ela acabou de responder sim à sua pergunta. Sem o sim, não chame." },
      },
      required: ["data", "hora", "motivo", "cliente_autorizou"],
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
    edicao: z.string().optional(),
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
    quantidade: z.number().int().min(1).max(20).optional(),
  }),
  ver_sacola: z.strictObject({}),
  remover_da_sacola: z.strictObject({
    sku: z.string().min(1),
  }),
  validar_cupom: z.strictObject({
    cupom: z.string().trim().min(1, "Informe o código do cupom.").max(40),
  }),
  cotar_frete: z.strictObject({
    cep: digitos(8, "CEP"),
    entregar_ate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "entregar_ate deve ser AAAA-MM-DD")
      .optional(),
    ocasiao: z.string().trim().max(60).optional(),
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
    entregar_ate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "entregar_ate deve ser AAAA-MM-DD")
      .optional(),
    ocasiao: z.string().trim().max(60).optional(),
    // Aceito e IGNORADO: o pedido usa o telefone da própria conversa. O
    // modelo tende a coletar telefone por instinto de vendedor — rejeitar o
    // campo travava a finalização (caso real em produção, 2026-08-26).
    telefone: z.string().optional(),
    forma_de_pagamento: z
      .enum(["online", "dinheiro_na_entrega"])
      .default("online"),
    presente: z
      .strictObject({
        para: z.string().trim().min(1).max(80),
        bilhete: z.string().trim().max(280).optional(),
        entregar_ate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "entregar_ate deve ser AAAA-MM-DD")
          .optional(),
      })
      .optional(),
  })
    // Ou o pedido reaproveita o cadastro salvo, ou traz o conjunto COMPLETO de
    // dados pessoais. Meio-termo produziria pedido sem endereço de entrega.
    .superRefine((valor, ctx) => {
      const endereco = ["cep", "rua", "numero", "bairro", "cidade", "uf"] as const;
      if (valor.usar_cadastro_salvo) {
        // Cadastro salvo + endereço novo: ou vem inteiro, ou não vem. Um
        // endereço pela metade cairia em silêncio no salvo (incidente #1012).
        if (!endereco.some((campo) => valor[campo] !== undefined)) return;
        for (const campo of endereco) {
          if (valor[campo] === undefined) {
            ctx.addIssue({
              code: "custom",
              path: [campo],
              message: `Com usar_cadastro_salvo e endereço novo, informe o endereço COMPLETO — falta ${campo}.`,
            });
          }
        }
        return;
      }
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
  historico_de_compras: z.strictObject({}),
  status_do_pedido: z.strictObject({
    numero_do_pedido: z.number().int().min(1).optional(),
  }),
  confirmar_entrega: z.strictObject({
    numero_do_pedido: z.number().int().min(1).optional(),
  }),
  enviar_chave_pix: z.strictObject({
    numero_do_pedido: z.number().int().min(1).optional(),
  }),
  avisar_dono: z.strictObject({
    mensagem: z.string().min(1).max(300),
  }),
  reservar_peca: z.strictObject({
    sku: z.string().min(1),
    quantidade: z.number().int().min(1).max(2).default(1),
  }),
  liberar_reserva: z.strictObject({}),
  avisar_quando_voltar: z.strictObject({
    sku: z.string().min(1),
  }),
  atualizar_cartela: z
    .strictObject({
      tamanhos: z
        .strictObject({
          vestido: z.string().trim().min(1).max(8).optional(),
          blusa: z.string().trim().min(1).max(8).optional(),
          calca: z.string().trim().min(1).max(8).optional(),
        })
        .optional(),
      cores_ama: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
      cores_evita: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
      caimento: z.enum(["justo", "fluido", "tanto_faz"]).optional(),
      ocasioes: z
        .array(z.enum(["trabalho", "dia_a_dia", "festa", "casamento", "viagem", "praia", "jantar"]))
        .max(7)
        .optional(),
      compra_para: z.enum(["mim", "presente", "os_dois"]).optional(),
      medidas: z
        .strictObject({
          busto_cm: z.number().min(60, "Busto em cm de contorno (a partir de 60) — 42 é numeração, não cm.").max(200).optional(),
          cintura_cm: z.number().min(50, "Cintura em cm de contorno (a partir de 50) — 42 é numeração, não cm.").max(200).optional(),
          quadril_cm: z.number().min(60, "Quadril em cm de contorno (a partir de 60) — 42 é numeração, não cm.").max(200).optional(),
          apagar: z.literal(true).optional(),
        })
        .optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: "Passe ao menos um campo da cartela." }),
  sugerir_tamanho: z.strictObject({
    produto: z.string().trim().min(1).max(120),
  }),
  enviar_nota_da_curadora: z.strictObject({
    produto: z.string().trim().min(1).max(120),
    reenviar: z.literal(true).optional(),
  }),
  montar_look: z.strictObject({
    produto: z.string().min(1),
    orcamento_reais: z.number().int().min(1).optional(),
  }),
  oferecer_gentileza: z.strictObject({
    motivo: z.string().trim().min(3, "Diga o motivo em poucas palavras.").max(140),
  }),
  anotar: z.strictObject({
    nota: z.string().trim().min(3).max(140),
  }),
  registrar_foto_com_a_peca: z.strictObject({
    produto: z.string().trim().min(1).max(120),
    foto: z.number().int().min(1).max(10).optional(),
  }),
  identificar_peca_na_foto: z.strictObject({
    foto: z.number().int().min(1).max(10).optional(),
    categoria: z.string().trim().max(60).optional(),
    cor: z.string().trim().max(40).optional(),
    busca: z.string().trim().max(80).optional(),
  }),
  retirar_minha_foto: z.strictObject({}),
  agendar_retorno: z.strictObject({
    data: z.string().trim().min(8).max(10),
    hora: z.string().trim().min(4).max(5),
    motivo: z.string().trim().min(3).max(140),
    cliente_autorizou: z.literal(true),
  }),
  transferir_para_atendente: z.strictObject({
    motivo: z.string().min(1),
    resumo: z.string().trim().max(600).optional(),
  }),
};
