import type { ToolExecutor } from "@/core/bot/tools";

import { getAdapterMode } from "../adapter-mode";
import { ClaudeSalesAssistant } from "./claude";
import { FakeSalesAssistant } from "./fake";

export type { ToolExecutor } from "@/core/bot/tools";

/** Foto da cliente já reduzida (≤ 1024 px) e codificada para o modelo. */
export type BotImageInput = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
};

export type BotChatMessage = {
  role: "user" | "assistant";
  text: string;
  /** Só na mensagem do turno atual: fotos antigas viram marcador de texto. */
  images?: BotImageInput[];
};

export type RespondTurnInput = {
  system: string;
  history: BotChatMessage[];
  model: string;
  executeTool: ToolExecutor;
};

export type AssistantTurn = {
  reply: string | null;
  toolCalls: { name: string; ok: boolean }[];
  handedOff: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens lidos do cache de prompt (custam 10% do normal). */
    cacheReadTokens?: number;
    /** Tokens gravados no cache (custam 2× quando ttl 1h). */
    cacheWriteTokens?: number;
  };
};

/**
 * Contrato do assistente de vendas. A IA conversa, mas nunca é fonte de
 * fatos: preços/estoque/frete/pedidos vêm das ferramentas, que devolvem
 * blocos de texto prontos que o modelo retransmite.
 */
export interface SalesAssistant {
  respondTurn(input: RespondTurnInput): Promise<AssistantTurn>;
}

export class AssistantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantUnavailableError";
  }
}

let instance: SalesAssistant | undefined;

export function getSalesAssistant(): SalesAssistant {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new ClaudeSalesAssistant()
        : new FakeSalesAssistant();
  }
  return instance;
}
