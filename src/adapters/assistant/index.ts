import type { ToolExecutor } from "@/core/bot/tools";

import { getAdapterMode } from "../adapter-mode";
import { ClaudeSalesAssistant } from "./claude";
import { FakeSalesAssistant } from "./fake";

export type { ToolExecutor } from "@/core/bot/tools";

export type BotChatMessage = {
  role: "user" | "assistant";
  text: string;
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
  usage: { inputTokens: number; outputTokens: number };
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
