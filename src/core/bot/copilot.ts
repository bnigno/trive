// Modo copiloto — PURO. A Lia pensa a resposta, mas quem manda é a dona: o
// turno vira uma sugestão na Central. Aqui mora o que decide sem I/O: o modo
// efetivo (o da conversa vence o da loja), quais ferramentas têm efeito no
// mundo (e por isso não rodam em copiloto) e o texto que a ferramenta
// bloqueada devolve ao modelo.
import { BOT_TOOL_NAMES, type BotToolName } from "@/core/bot/tools";

export const BOT_MODES = ["autonomous", "copilot"] as const;
export type BotMode = (typeof BOT_MODES)[number];

export function isBotMode(value: unknown): value is BotMode {
  return typeof value === "string" && (BOT_MODES as readonly string[]).includes(value);
}

/** O modo da conversa (override) vence o da loja; valor torto cai em autônoma. */
export function resolveBotMode(storeMode: unknown, conversationMode: unknown): BotMode {
  if (isBotMode(conversationMode)) return conversationMode;
  if (isBotMode(storeMode)) return storeMode;
  return "autonomous";
}

/**
 * Ferramentas com efeito fora da conversa (pedido, Pix, reserva, aviso ao
 * dono, transferência, retorno, foto, entrega): em copiloto NÃO rodam — a
 * dona decide. As de leitura consultam de graça; as de estado só mexem no
 * caderninho (sacola, cartela, nota), que a dona vê no painel.
 */
export const EFFECT_TOOLS: ReadonlySet<BotToolName> = new Set<BotToolName>([
  "criar_pedido",
  "enviar_chave_pix",
  "avisar_dono",
  "reservar_peca",
  "liberar_reserva",
  "avisar_quando_voltar",
  "transferir_para_atendente",
  "confirmar_entrega",
  "registrar_foto_com_a_peca",
  "retirar_minha_foto",
  "agendar_retorno",
  "oferecer_gentileza",
]);

export const STATE_TOOLS: ReadonlySet<BotToolName> = new Set<BotToolName>([
  "adicionar_a_sacola",
  "remover_da_sacola",
  "atualizar_cartela",
  "anotar",
]);

export const READ_TOOLS: ReadonlySet<BotToolName> = new Set<BotToolName>(
  BOT_TOOL_NAMES.filter((name) => !EFFECT_TOOLS.has(name) && !STATE_TOOLS.has(name)),
);

export function isToolBlockedInCopilot(name: BotToolName): boolean {
  return EFFECT_TOOLS.has(name);
}

/** O que o modelo lê quando chama uma ferramenta de efeito em copiloto. */
export function copilotBlockedText(name: BotToolName): string {
  return `[Copiloto: ${name} não roda agora — a equipe decide e faz por você. Diga à cliente, em 1 frase, que a equipe cuida disso em instantes; não prometa prazo nem invente o resultado.]`;
}

/** "agora" / "há 3 min" / "há 2 h" — a idade da sugestão no cartão. */
export function suggestionAgeLabel(createdAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}
