import { describe, expect, it } from "vitest";

import type {
  BotChatMessage,
  SalesAssistant,
  ToolExecutor,
} from "@/adapters/assistant";
import { FakeSalesAssistant } from "@/adapters/assistant/fake";

type ExecutedCall = { name: string; input: unknown };

function makeExecutor() {
  const calls: ExecutedCall[] = [];
  const executeTool: ToolExecutor = async (name, input) => {
    calls.push({ name, input });
    if (name === "transferir_para_atendente") {
      return { ok: true, text: "Transferindo para um atendente…", endsTurn: true };
    }
    return { ok: true, text: `RESULTADO(${name})` };
  };
  return { calls, executeTool };
}

function makeHistory(lastUserText: string): BotChatMessage[] {
  return [
    { role: "user", text: "Oi" },
    { role: "assistant", text: "Olá! Como posso ajudar?" },
    { role: "user", text: lastUserText },
  ];
}

function makeInput(executeTool: ToolExecutor, lastUserText = "Quero ver os produtos") {
  return {
    system: "Você é o assistente de vendas do TRIVË.",
    history: makeHistory(lastUserText),
    model: "claude-sonnet-5",
    executeTool,
  };
}

describe("FakeSalesAssistant (contrato SalesAssistant)", () => {
  it("roteiro com 2 toolCalls executa na ordem e entrega os textos ao template", async () => {
    const fake = new FakeSalesAssistant();
    const { calls, executeTool } = makeExecutor();
    fake.enqueueScript({
      toolCalls: [
        { name: "listar_produtos", input: { busca: "colar" } },
        { name: "cotar_frete", input: { cep: "01310-100" } },
      ],
      replyTemplate: (toolTexts) => `Achei isto:\n${toolTexts.join("\n")}`,
    });

    const turn = await fake.respondTurn(makeInput(executeTool));

    expect(calls).toEqual([
      { name: "listar_produtos", input: { busca: "colar" } },
      { name: "cotar_frete", input: { cep: "01310-100" } },
    ]);
    expect(turn.reply).toBe(
      "Achei isto:\nRESULTADO(listar_produtos)\nRESULTADO(cotar_frete)",
    );
    expect(turn.toolCalls).toEqual([
      { name: "listar_produtos", ok: true },
      { name: "cotar_frete", ok: true },
    ]);
    expect(turn.handedOff).toBe(false);
  });

  it("endsTurn interrompe as ferramentas restantes e marca handedOff", async () => {
    const fake = new FakeSalesAssistant();
    const { calls, executeTool } = makeExecutor();
    fake.enqueueScript({
      toolCalls: [
        { name: "transferir_para_atendente", input: { motivo: "pedido complexo" } },
        { name: "listar_produtos", input: {} },
      ],
      replyTemplate: (toolTexts) => toolTexts.join(" | "),
    });

    const turn = await fake.respondTurn(makeInput(executeTool));

    expect(calls).toEqual([
      { name: "transferir_para_atendente", input: { motivo: "pedido complexo" } },
    ]);
    expect(turn.handedOff).toBe(true);
    expect(turn.toolCalls).toEqual([
      { name: "transferir_para_atendente", ok: true },
    ]);
    expect(turn.reply).toBe("Transferindo para um atendente…");
  });

  it("replyTemplate string é usado literalmente", async () => {
    const fake = new FakeSalesAssistant();
    const { executeTool } = makeExecutor();
    fake.enqueueScript({ replyTemplate: "Resposta fixa do roteiro" });

    const turn = await fake.respondTurn(makeInput(executeTool));

    expect(turn.reply).toBe("Resposta fixa do roteiro");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.handedOff).toBe(false);
  });

  it("fila vazia ecoa a última mensagem do usuário", async () => {
    const fake = new FakeSalesAssistant();
    const { calls, executeTool } = makeExecutor();

    const turn = await fake.respondTurn(
      makeInput(executeTool, "Tem colar de prata?"),
    );

    expect(turn.reply).toBe("FAKE: Tem colar de prata?");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.handedOff).toBe(false);
    expect(calls).toEqual([]);
  });

  it("registra os turns inspecionáveis na ordem", async () => {
    const fake = new FakeSalesAssistant();
    const { executeTool } = makeExecutor();
    fake.enqueueScript({ replyTemplate: "Primeiro" });

    await fake.respondTurn(makeInput(executeTool));
    await fake.respondTurn(makeInput(executeTool, "E o frete?"));

    expect(fake.turns).toHaveLength(2);
    expect(fake.turns[0]?.reply).toBe("Primeiro");
    expect(fake.turns[1]?.reply).toBe("FAKE: E o frete?");
  });

  it("reset limpa a fila de roteiros e os turns", async () => {
    const fake = new FakeSalesAssistant();
    const { executeTool } = makeExecutor();
    fake.enqueueScript({ replyTemplate: "Não deve sobrar" });

    fake.reset();

    expect(fake.turns).toHaveLength(0);
    const turn = await fake.respondTurn(makeInput(executeTool, "Oi de novo"));
    expect(turn.reply).toBe("FAKE: Oi de novo");
  });

  it("satisfaz a interface SalesAssistant", () => {
    const assistant: SalesAssistant = new FakeSalesAssistant();
    expect(assistant.respondTurn).toBeTypeOf("function");
  });
});
