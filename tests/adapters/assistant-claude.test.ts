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
  it("foto anexada vira bloco de imagem base64 antes do texto; sem foto o content segue string", async () => {
    const client = fakeClient([textMessage("Que peça linda! Vi aqui…")]);
    await new ClaudeSalesAssistant(client).respondTurn({
      ...baseInput,
      history: [
        { role: "user", text: "oi" },
        { role: "assistant", text: "Oi! Como posso ajudar?" },
        {
          role: "user",
          text: "[a cliente enviou uma foto] tem parecida?",
          images: [{ mediaType: "image/jpeg", base64: "AAAA" }],
        },
      ],
    });
    const [call] = client.calls as Anthropic.MessageCreateParamsNonStreaming[];
    expect(call.messages[0]).toEqual({ role: "user", content: "oi" });
    expect(call.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        { type: "text", text: "[a cliente enviou uma foto] tem parecida?" },
      ],
    });
  });

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

describe("ClaudeSalesAssistant.extractFromPhotos", () => {
  const input = {
    system: "Monte a ficha.",
    images: [
      { mediaType: "image/jpeg" as const, base64: "AAAA" },
      { mediaType: "image/jpeg" as const, base64: "BBBB" },
    ],
    userText: "Fotos em anexo.",
    model: "claude-sonnet-5",
    jsonSchema: { type: "object", properties: { name: { type: "string" } } },
  };

  it("manda imagens antes do texto, pede saída estruturada, sem ferramentas, e devolve o JSON com o uso", async () => {
    const create = vi.fn(async (_params: unknown) => textMessage('{"name":"Vestido Áurea"}'));
    const assistant = new ClaudeSalesAssistant({ messages: { create } } as unknown as MessagesClient);

    const result = await assistant.extractFromPhotos(input);
    expect(result.json).toEqual({ name: "Vestido Áurea" });
    expect(result.usage.inputTokens).toBe(100);

    const request = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.tools).toBeUndefined();
    expect(request.system).toBe("Monte a ficha.");
    // effort baixo: extrair de foto não pede raciocínio longo, e o pensamento
    // sai do mesmo teto de max_tokens (que precisa caber a ficha inteira).
    expect(request.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: input.jsonSchema },
    });
    expect(request.max_tokens).toBeGreaterThanOrEqual(4096);
    const content = (request.messages as { content: { type: string }[] }[])[0].content;
    expect(content.map((block) => block.type)).toEqual(["image", "image", "text"]);
  });

  it("no Haiku não manda effort (o modelo não aceita)", async () => {
    const create = vi.fn(async (_params: unknown) => textMessage("{}"));
    const assistant = new ClaudeSalesAssistant({ messages: { create } } as unknown as MessagesClient);
    await assistant.extractFromPhotos({ ...input, model: "claude-haiku-4-5" });
    const request = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.output_config).toEqual({
      format: { type: "json_schema", schema: input.jsonSchema },
    });
  });

  it("resposta cortada por max_tokens vira erro próprio (não se confunde com JSON torto)", async () => {
    const cortada = new ClaudeSalesAssistant({
      messages: { create: async () => textMessage('{"name":"Ves', "max_tokens") },
    } as unknown as MessagesClient);
    await expect(cortada.extractFromPhotos(input)).rejects.toThrow(/cortada antes do fim/);
  });

  it("recusa, JSON torto e APIError viram AssistantUnavailableError", async () => {
    const refusal = new ClaudeSalesAssistant({
      messages: { create: async () => textMessage("", "refusal") },
    } as unknown as MessagesClient);
    await expect(refusal.extractFromPhotos(input)).rejects.toBeInstanceOf(AssistantUnavailableError);

    const torto = new ClaudeSalesAssistant({
      messages: { create: async () => textMessage("não é json") },
    } as unknown as MessagesClient);
    await expect(torto.extractFromPhotos(input)).rejects.toBeInstanceOf(AssistantUnavailableError);

    const apiError = new ClaudeSalesAssistant({
      messages: {
        create: async () => {
          throw new Anthropic.APIError(500, undefined, "erro", undefined);
        },
      },
    } as unknown as MessagesClient);
    await expect(apiError.extractFromPhotos(input)).rejects.toBeInstanceOf(AssistantUnavailableError);
  });
});
