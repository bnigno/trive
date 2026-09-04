// O adapter da Anthropic nunca tinha teste: o loop de tool_use, a recusa, o
// estouro de iterações e o APIError → AssistantUnavailableError eram
// verificados só em produção. Cliente falso injetado, sem rede nem chave.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { AssistantUnavailableError } from "@/adapters/assistant";
import {
  ClaudeSalesAssistant,
  type MessagesClient,
} from "@/adapters/assistant/claude";
import type { ToolExecutor } from "@/core/bot/tools";

type Message = Anthropic.Message;

function textMessage(text: string, stop: Message["stop_reason"] = "end_turn"): Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 500,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Message;
}

function toolUseMessage(name: string, input: unknown): Message {
  return {
    ...textMessage("Deixa eu ver aqui…", "tool_use"),
    content: [
      { type: "text", text: "Deixa eu ver aqui…", citations: null },
      { type: "tool_use", id: "tu_1", name, input },
    ],
  } as unknown as Message;
}

function fakeClient(responses: Message[]): MessagesClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    messages: {
      create: vi.fn(async (params) => {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error("sem resposta roteirizada");
        return next;
      }),
    },
  };
}

const executeTool: ToolExecutor = vi.fn(async (name) => ({
  ok: true,
  text: `resultado de ${name}`,
  ...(name === "transferir_para_atendente" ? { endsTurn: true } : {}),
}));

const baseInput = {
  system: "prompt",
  history: [{ role: "user" as const, text: "oi" }],
  model: "claude-sonnet-5",
  executeTool,
};

describe("ClaudeSalesAssistant", () => {
  it("roda o loop tool_use → tool_result e soma o uso, inclusive cache", async () => {
    const client = fakeClient([
      toolUseMessage("listar_produtos", { busca: "vestido" }),
      textMessage("Toque em «Ver o catálogo» 👇"),
    ]);
    const assistant = new ClaudeSalesAssistant(client);

    const turn = await assistant.respondTurn(baseInput);

    expect(turn.reply).toBe("Toque em «Ver o catálogo» 👇");
    expect(turn.toolCalls).toEqual([{ name: "listar_produtos", ok: true }]);
    expect(turn.handedOff).toBe(false);
    expect(turn.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
    });

    const [first, second] = client.calls as Anthropic.MessageCreateParamsNonStreaming[];
    // Prefixo cacheado por 1 h; effort medium em Sonnet; 2048 tokens de saída.
    expect(first.system).toEqual([
      { type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first.max_tokens).toBe(2048);
    // A segunda chamada carrega o tool_result num único user message.
    const last = second.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "resultado de listar_produtos",
        is_error: false,
      },
    ]);
  });

  it("Haiku não recebe effort", async () => {
    const client = fakeClient([textMessage("oi")]);
    await new ClaudeSalesAssistant(client).respondTurn({
      ...baseInput,
      model: "claude-haiku-4-5",
    });
    const [request] = client.calls as Anthropic.MessageCreateParamsNonStreaming[];
    expect(request.output_config).toBeUndefined();
  });

  it("transferir_para_atendente encerra o turno sem nova chamada ao modelo", async () => {
    const client = fakeClient([
      toolUseMessage("transferir_para_atendente", { motivo: "quer trocar" }),
    ]);
    const turn = await new ClaudeSalesAssistant(client).respondTurn(baseInput);
    expect(turn.handedOff).toBe(true);
    expect(turn.reply).toBe("Deixa eu ver aqui…");
    expect(client.calls).toHaveLength(1);
  });

  it("recusa do modelo vira transferência silenciosa", async () => {
    const client = fakeClient([textMessage("", "refusal")]);
    const turn = await new ClaudeSalesAssistant(client).respondTurn(baseInput);
    expect(turn).toMatchObject({ reply: null, handedOff: true });
  });

  it("estourar 6 iterações transfere para a equipe com o texto acumulado", async () => {
    const client = fakeClient(
      Array.from({ length: 6 }, () => toolUseMessage("ver_sacola", {})),
    );
    const turn = await new ClaudeSalesAssistant(client).respondTurn(baseInput);
    expect(turn.handedOff).toBe(true);
    expect(turn.toolCalls).toHaveLength(6);
    expect(turn.reply).toContain("Deixa eu ver aqui…");
  });

  it("APIError da Anthropic vira AssistantUnavailableError (o turno cai no plano B)", async () => {
    const client: MessagesClient = {
      messages: {
        create: async () => {
          throw new Anthropic.APIError(529, undefined, "overloaded", undefined);
        },
      },
    };
    await expect(
      new ClaudeSalesAssistant(client).respondTurn(baseInput),
    ).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it("sem chave e sem cliente injetado, falha como indisponível", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(new ClaudeSalesAssistant().respondTurn(baseInput)).rejects.toBeInstanceOf(
      AssistantUnavailableError,
    );
    vi.unstubAllEnvs();
  });
});
