import Anthropic from "@anthropic-ai/sdk";

import { BOT_TOOLS, type BotToolName } from "@/core/bot/tools";

import type {
  AssistantTurn,
  ExtractFromPhotosInput,
  ExtractFromPhotosResult,
  RespondTurnInput,
  SalesAssistant,
} from "./index";
import { AssistantUnavailableError } from "./index";

const MAX_ITERATIONS = 6;
const HANDOFF_FALLBACK_REPLY = "Vou te passar para a equipe 😉";

/**
 * Subconjunto do cliente da Anthropic que o adapter usa. Existe para os
 * testes injetarem um cliente falso (loop de tool_use, refusal, estouro de
 * iterações, APIError) sem rede e sem chave.
 */
export type MessagesClient = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
};

export class ClaudeSalesAssistant implements SalesAssistant {
  private client: MessagesClient | undefined;

  constructor(client?: MessagesClient) {
    this.client = client;
  }

  private getClient(): MessagesClient {
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

  /**
   * Uma chamada só, sem ferramentas: imagens + texto entram, JSON no formato
   * pedido sai (saída estruturada). Recusa ou JSON torto = indisponível —
   * o rascunho nunca nasce de um texto parcial.
   */
  async extractFromPhotos(input: ExtractFromPhotosInput): Promise<ExtractFromPhotosResult> {
    const client = this.getClient();
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: input.model,
      max_tokens: input.maxTokens ?? 2048,
      system: input.system,
      messages: [
        {
          role: "user",
          content: [
            ...input.images.map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.base64 },
            })),
            { type: "text" as const, text: input.userText },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: input.jsonSchema } },
    };
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(request);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new AssistantUnavailableError(
          "Assistente de IA indisponível no momento — tente novamente em instantes",
        );
      }
      throw error;
    }
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    if (response.stop_reason === "refusal") {
      throw new AssistantUnavailableError("O modelo recusou ler estas fotos.");
    }
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      return { json: JSON.parse(text) as unknown, usage };
    } catch {
      throw new AssistantUnavailableError("A resposta do modelo não veio no formato esperado.");
    }
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

    // Foto anexada vira bloco de imagem antes do texto (Sonnet é multimodal).
    const messages: Anthropic.MessageParam[] = history.map((message) => ({
      role: message.role,
      content:
        message.images && message.images.length > 0
          ? [
              ...message.images.map(
                (image): Anthropic.ImageBlockParam => ({
                  type: "image",
                  source: { type: "base64", media_type: image.mediaType, data: image.base64 },
                }),
              ),
              { type: "text", text: message.text } satisfies Anthropic.TextBlockParam,
            ]
          : message.text,
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
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const assistantTexts: string[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 2048,
        // Cache de 1 h no prefixo (prompt + ferramentas): entre duas mensagens
        // de WhatsApp costumam passar mais de 5 min, e o prefixo tem ~6 K
        // tokens — reescrever a cada turno custava mais do que a resposta.
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        tools,
        messages,
      };
      // Haiku 4.5 não suporta effort; Sonnet 5+ com effort medium (raciocínio
      // suficiente para seguir o método de venda sem pesar na latência).
      if (!model.startsWith("claude-haiku")) {
        request.output_config = { effort: "medium" };
      }

      const response = await client.messages.create(request);
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

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

    // Estourou o limite de iterações: transfere para a equipe.
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
