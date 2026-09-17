// O vigia (puro): que chat vira buraco, e o texto do alerta.
import { describe, expect, it } from "vitest";

import { findInboundGaps, WATCHDOG, watchdogAlertBody, type WatchdogChat, type WatchdogKnown } from "@/core/whatsapp/watchdog";

const now = new Date("2026-09-16T22:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

const seen = (at: Date, extra: Partial<WatchdogKnown> = {}): WatchdogKnown => ({ at, inboundAt: at, botReads: true, ...extra });
const chat = (address: string, name: string | null, lastMessageAt: Date, unread = 0): WatchdogChat => ({ address, name, lastMessageAt, unread });

describe("findInboundGaps — sinal 1: movimento mais novo que tudo o que temos", () => {
  it("chat com movimento novo e nada registrado é buraco; registrado depois da mensagem não é; tolerância de relógio", () => {
    const gaps = findInboundGaps({
      now,
      chats: [
        chat("+5591999991528", "Sogra", minutesAgo(10)),
        chat("+5591999997536", "Fabiano", minutesAgo(30)),
        chat("220839349862480@lid", null, minutesAgo(20)),
        chat("+5591999992995", "Quase", minutesAgo(15)),
      ],
      known: new Map([
        ["+5591999997536", seen(minutesAgo(29))],
        ["+5591999992995", seen(new Date(minutesAgo(15).getTime() - WATCHDOG.toleranceMs + 1000))],
      ]),
    });
    expect(gaps.map((g) => [g.address, g.reason])).toEqual([
      ["+5591999991528", "movimento_novo"],
      ["220839349862480@lid", "movimento_novo"],
    ]);
    expect(gaps[0].knownAt).toBeNull();
  });

  it("mensagem de agora (ainda a caminho) e movimento velho demais não contam", () => {
    const gaps = findInboundGaps({
      now,
      chats: [chat("+5591999990001", "Agora", minutesAgo(1)), chat("+5591999990002", "Ontem", minutesAgo(7 * 60))],
      known: new Map(),
    });
    expect(gaps).toEqual([]);
  });

  it("registro mais antigo que a mensagem (além da tolerância) é buraco, ordenado do mais recente", () => {
    const gaps = findInboundGaps({
      now,
      chats: [chat("+5591999990003", "A", minutesAgo(40)), chat("+5591999990004", "B", minutesAgo(5))],
      known: new Map([
        ["+5591999990003", seen(minutesAgo(50))],
        ["+5591999990004", seen(minutesAgo(9))],
      ]),
    });
    expect(gaps.map((g) => g.name)).toEqual(["B", "A"]);
  });
});

describe("findInboundGaps — sinal 2: não-lida que a Lia teria lido", () => {
  it("mensagem perdida às 20:00 seguida de um envio nosso às 20:30: a atividade bate, mas o chat tem não-lida e a última recebida é velha → buraco", () => {
    const gaps = findInboundGaps({
      now,
      chats: [chat("+5591999990005", "Cliente", minutesAgo(30), 1)],
      known: new Map([["+5591999990005", seen(minutesAgo(30), { inboundAt: minutesAgo(90) })]]),
    });
    expect(gaps.map((g) => g.reason)).toEqual(["nao_lida"]);
  });

  it("não-lida numa conversa que a Lia NÃO lê (humana, copiloto, bot silenciado) ou sem não-lida não é buraco; recebida registrada recente também não", () => {
    const gaps = findInboundGaps({
      now,
      chats: [
        chat("+5591999990006", "Humana", minutesAgo(30), 2),
        chat("+5591999990007", "Lida", minutesAgo(30), 0),
        chat("+5591999990008", "Recebida", minutesAgo(30), 1),
      ],
      known: new Map([
        ["+5591999990006", seen(minutesAgo(30), { inboundAt: minutesAgo(90), botReads: false })],
        ["+5591999990007", seen(minutesAgo(30), { inboundAt: minutesAgo(90) })],
        ["+5591999990008", seen(minutesAgo(29), { inboundAt: minutesAgo(31) })],
      ]),
    });
    expect(gaps).toEqual([]);
  });
});

describe("watchdogAlertBody", () => {
  it("lista até 5 chats com hora local e diz o que fazer", () => {
    const body = watchdogAlertBody(
      [
        { address: "+5591999991528", name: "Sogra", lastMessageAt: new Date("2026-09-16T22:50:00Z"), knownAt: null, reason: "movimento_novo" },
        { address: "x@lid", name: null, lastMessageAt: new Date("2026-09-16T22:40:00Z"), knownAt: null, reason: "nao_lida" },
      ],
      "America/Belem",
    );
    expect(body).toContain("2 chats tiveram mensagem que NÃO chegou ao sistema");
    expect(body).toContain("• Sogra às 19:50");
    expect(body).toContain("• número oculto às 19:40");
    expect(body).toContain("responda pelo celular da loja");
  });
});
