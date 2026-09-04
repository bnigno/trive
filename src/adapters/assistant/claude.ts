import Anthropic from "@anthropic-ai/sdk";

import { BOT_TOOLS, type BotToolName } from "@/core/bot/tools";

import type {
  AssistantTurn,
  RespondTurnInput,
  SalesAssistant,
} from "./index";
import { AssistantUnavailableError } from "./index";

const MAX_ITERATIONS = 6;
const HANDOFF_FALLBACK_REPLY = "Vou te passar para um atendente 😉";

export class ClaudeSalesAssistant implements SalesAssistant {
  private client: Anthropic | undefined;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new AssistantUnavailableError(
          "Assistente de IA não configurado — informe a ANTHROPIC_API_KEY",
        );
      }
      // A rota do Inngest tem 60 s: um turno lento precisa falhar dentro
      // desse teto (o default do SDK é 10 min com 2 tentativas — a função
      // morreria antes e o evento ficaria preso até o lease expirar).
      this.client = new Anthropic({ timeout: 40_000, maxRetries: 1 });
    }
    return this.client;
  }

  async respondTurn(input: RespondTurnInput): Promise<AssistantTurn> {
    try {
      return await this.runLoop(input);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new AssistantUnavailableError(
          "Assistente de IA indisponível no momento — tente novamente em instantes",
        );
      }
      throw error;
    }
  }

  private async runLoop(input: RespondTurnInput): Promise<AssistantTurn> {
    const { system, history, model, executeTool } = input;
    const client = this.getClient();

    const messages: Anthropic.MessageParam[] = history.map((message) => ({
      role: message.role,
      content: message.text,
    }));
    // A API exige que a primeira mensagem seja 'user'.
    if (messages[0]?.role !== "user") {
      messages.unshift({ role: "user", content: "(início da conversa)" });
    }

    const tools: Anthropic.Tool[] = BOT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    }));

    const toolCalls: { name: string; ok: boolean }[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const assistantTexts: string[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 1024,
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        tools,
        messages,
      };
      // Haiku 4.5 não suporta effort; Sonnet 5+ com effort low e thinking
      // omitido (= adaptativo).
      if (!model.startsWith("claude-haiku")) {
        request.output_config = { effort: "low" };
      }

      const response = await client.messages.create(request);
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;

      const turnText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (turnText) assistantTexts.push(turnText);

      if (response.stop_reason === "refusal") {
        return { reply: null, toolCalls, handedOff: true, usage };
      }

      if (response.stop_reason !== "tool_use") {
        // end_turn / max_tokens: entrega o texto desta resposta.
        return {
          reply: turnText || null,
          toolCalls,
          handedOff: false,
          usage,
        };
      }

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let endsTurn = false;
      for (const block of toolUseBlocks) {
        const result = await executeTool(block.name as BotToolName, block.input);
        toolCalls.push({ name: block.name, ok: result.ok });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.text,
          is_error: !result.ok,
        });
        if (result.endsTurn) endsTurn = true;
      }
      // Todos os tool_result num único user message.
      messages.push({ role: "user", content: toolResults });

      if (endsTurn) {
        // Handoff: para o loop sem nova chamada ao modelo.
        return {
          reply: assistantTexts.at(-1) ?? null,
          toolCalls,
          handedOff: true,
          usage,
        };
      }
    }

    // Estourou o limite de iterações: transfere para atendente.
    return {
      reply:
        assistantTexts.length > 0
          ? assistantTexts.join("\n")
          : HANDOFF_FALLBACK_REPLY,
      toolCalls,
      handedOff: true,
      usage,
    };
  }
}
