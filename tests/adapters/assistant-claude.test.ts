// O adapter da Anthropic nunca tinha teste: o loop de tool_use, a recusa, o
// estouro de iterações e o APIError → AssistantUnavailableError eram
// verificados só em produção. Cliente falso injetado, sem rede nem chave.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { AssistantUnavailableError } from "@/adapters/assistant";
import {
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_TIMEOUT_MS,
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

  // O erro real da API era engolido: o painel só dizia "indisponível" e a
  // fila transferia para a equipe na hora, mesmo num limite por minuto que
  // passa em segundos. Agora cada status vira causa curta + "vale tentar".
  it.each([
    [429, "rate_limit_error", "rate limited", "limite de uso da API (429)", true],
    [529, "overloaded_error", "overloaded", "API da Anthropic instável (529)", true],
    [500, "api_error", "internal", "API da Anthropic instável (500)", true],
    [401, "authentication_error", "invalid x-api-key", "chave da API inválida (401)", false],
    [404, "not_found_error", "model: nope", "modelo não encontrado (404): claude-sonnet-5", false],
    [400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.", "sem crédito na API da Anthropic", false],
    // Pedido malformado é bug nosso: a frase da API vai junto (foi assim que se achou o "prefill" de 19/09).
    [400, "invalid_request_error", "messages: bad", "erro 400 da API (invalid_request_error): messages: bad", false],
    [400, "invalid_request_error", "You have reached your specified API usage limits.", "limite de gasto configurado na conta da Anthropic atingido", false],
    [402, "billing_error", "billing issue", "problema de cobrança na API da Anthropic (402)", false],
  ])("status %s (%s) → causa \"%s\" e retryable=%s", async (status, type, message, reason, retryable) => {
    const client: MessagesClient = {
      messages: {
        create: async () => {
          throw new Anthropic.APIError(status, { type: "error", error: { type, message } }, message, new Headers({ "request-id": "req_1" }), type as never);
        },
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await new ClaudeSalesAssistant(client).respondTurn(baseInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantUnavailableError);
    const failure = error as AssistantUnavailableError;
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(type);
    expect(failure.reason).toBe(reason);
    expect(failure.retryable).toBe(retryable);
    expect(spy).toHaveBeenCalledWith("[assistant] falha na API da Anthropic", expect.objectContaining({ status, reason, requestId: "req_1" }));
    spy.mockRestore();
  });

  it("429 por teto de gasto do mês (spend limit no corpo) não é passageiro", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client: MessagesClient = {
      messages: {
        create: async () => {
          throw new Anthropic.APIError(
            429,
            { type: "error", error: { type: "rate_limit_error", message: "Spend limit reached", details: { error_code: "enforced_spend_limit_reached" } } },
            "Spend limit reached",
            new Headers(),
            "rate_limit_error",
          );
        },
      },
    };
    const error = await new ClaudeSalesAssistant(client).respondTurn(baseInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantUnavailableError);
    expect((error as AssistantUnavailableError).retryable).toBe(false);
    expect((error as AssistantUnavailableError).reason).toBe("teto de gasto da API atingido (429)");
    expect((error as AssistantUnavailableError).message).toContain("teto de gasto da API atingido (429)");
    spy.mockRestore();
  });

  it("sem conexão (timeout) é passageiro; abort não é", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = async (client: MessagesClient): Promise<AssistantUnavailableError> => {
      const error = await new ClaudeSalesAssistant(client).respondTurn(baseInput).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AssistantUnavailableError);
      return error as AssistantUnavailableError;
    };
    const t = await failure({ messages: { create: async () => { throw new Anthropic.APIConnectionTimeoutError(); } } });
    expect(t.retryable).toBe(true);
    expect(t.reason).toBe("a API não respondeu a tempo");
    expect(t.status).toBeUndefined();
    const a = await failure({ messages: { create: async () => { throw new Anthropic.APIUserAbortError(); } } });
    expect(a.retryable).toBe(false);
    // Abort é quem chamou desistindo (orçamento da visão): caminho esperado, sem log de erro.
    expect(a.reason).toBe("chamada cancelada por quem chamou");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("prazo do turno: sem tempo para outra chamada, devolve 'tempo esgotado' (passageiro) sem chamar de novo", async () => {
    // 1ª chamada pede ferramenta (com 5,1 s de prazo ela ainda cabe); a
    // ferramenta leva 200 ms e aí não sobram os 5 s mínimos para a 2ª.
    const client = fakeClient([toolUseMessage("ver_sacola", {}), textMessage("nunca chega")]);
    const slowTool: ToolExecutor = async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true, text: `resultado de ${name}` };
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await new ClaudeSalesAssistant(client)
      .respondTurn({ ...baseInput, executeTool: slowTool, deadlineAt: new Date(Date.now() + 5_100) })
      .then(
        () => null,
        (e: unknown) => e as AssistantUnavailableError,
      );
    expect(client.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(AssistantUnavailableError);
    expect(error?.retryable).toBe(true);
    expect(error?.reason).toBe("tempo esgotado");
    spy.mockRestore();
  }, 20_000);

  it("cada chamada leva o timeout do que sobra do prazo (nunca acima do teto do SDK) — sem AbortSignal, que o SDK trata como abort definitivo", async () => {
    const client = fakeClient([textMessage("oi")]);
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    await new ClaudeSalesAssistant(client).respondTurn({ ...baseInput, deadlineAt: new Date(Date.now() + 8_000) });
    const options = create.mock.calls[0]?.[1] as { signal?: AbortSignal; timeout?: number };
    expect(options.signal).toBeUndefined();
    expect(options.timeout).toBeGreaterThan(5_000);
    expect(options.timeout).toBeLessThanOrEqual(8_000);

    const client2 = fakeClient([textMessage("oi")]);
    await new ClaudeSalesAssistant(client2).respondTurn(baseInput);
    const options2 = (client2.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { timeout?: number };
    expect(options2.timeout).toBe(ANTHROPIC_TIMEOUT_MS);
    expect(ANTHROPIC_MAX_RETRIES).toBe(0);
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
