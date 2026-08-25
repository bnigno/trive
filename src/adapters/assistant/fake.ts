import type { BotToolName } from "@/core/bot/tools";

import type {
  AssistantTurn,
  RespondTurnInput,
  SalesAssistant,
} from "./index";

export type FakeTurnScript = {
  toolCalls?: { name: BotToolName; input: unknown }[];
  replyTemplate: string | ((toolTexts: string[]) => string);
};

/**
 * Assistente roteirizável para testes/demos: cada respondTurn consome o
 * próximo roteiro da fila (executando as ferramentas na ordem); sem roteiro,
 * ecoa a última mensagem do usuário.
 */
export class FakeSalesAssistant implements SalesAssistant {
  private readonly scripts: FakeTurnScript[] = [];
  readonly turns: AssistantTurn[] = [];

  enqueueScript(script: FakeTurnScript): void {
    this.scripts.push(script);
  }

  async respondTurn(input: RespondTurnInput): Promise<AssistantTurn> {
    const script = this.scripts.shift();
    const turn = script
      ? await this.playScript(script, input)
      : this.echoTurn(input);
    this.turns.push(turn);
    return turn;
  }

  private async playScript(
    script: FakeTurnScript,
    input: RespondTurnInput,
  ): Promise<AssistantTurn> {
    const toolTexts: string[] = [];
    const toolCalls: { name: string; ok: boolean }[] = [];
    let handedOff = false;

    for (const call of script.toolCalls ?? []) {
      const result = await input.executeTool(call.name, call.input);
      toolCalls.push({ name: call.name, ok: result.ok });
      toolTexts.push(result.text);
      if (result.endsTurn) {
        handedOff = true;
        break;
      }
    }

    const reply =
      typeof script.replyTemplate === "function"
        ? script.replyTemplate(toolTexts)
        : script.replyTemplate;

    return {
      reply,
      toolCalls,
      handedOff,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private echoTurn(input: RespondTurnInput): AssistantTurn {
    const lastUserMessage = input.history
      .filter((message) => message.role === "user")
      .at(-1);
    return {
      reply: `FAKE: ${lastUserMessage?.text ?? ""}`,
      toolCalls: [],
      handedOff: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  reset(): void {
    this.scripts.length = 0;
    this.turns.length = 0;
  }
}
