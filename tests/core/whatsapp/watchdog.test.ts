// O vigia (puro): que chat vira buraco, e o texto do alerta.
import { describe, expect, it } from "vitest";

import { findInboundGaps, WATCHDOG, watchdogAlertBody } from "@/core/whatsapp/watchdog";

const now = new Date("2026-09-16T22:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("findInboundGaps", () => {
  it("chat com movimento novo e nada registrado é buraco; registrado depois da mensagem não é; tolerância de relógio", () => {
    const gaps = findInboundGaps({
      now,
      chats: [
        { address: "+5591999991528", name: "Sogra", lastMessageAt: minutesAgo(10) },
        { address: "+5591999997536", name: "Fabiano", lastMessageAt: minutesAgo(30) },
        { address: "220839349862480@lid", name: null, lastMessageAt: minutesAgo(20) },
        { address: "+5591999992995", name: "Quase", lastMessageAt: minutesAgo(15) },
      ],
      known: new Map([
        ["+5591999997536", minutesAgo(29)],
        ["+5591999992995", new Date(minutesAgo(15).getTime() - WATCHDOG.toleranceMs + 1000)],
      ]),
    });
    expect(gaps.map((g) => g.address)).toEqual(["+5591999991528", "220839349862480@lid"]);
    expect(gaps[0].knownAt).toBeNull();
  });

  it("mensagem de agora (ainda a caminho) e movimento velho demais não contam", () => {
    const gaps = findInboundGaps({
      now,
      chats: [
        { address: "+5591999990001", name: "Agora", lastMessageAt: minutesAgo(1) },
        { address: "+5591999990002", name: "Ontem", lastMessageAt: minutesAgo(7 * 60) },
      ],
      known: new Map(),
    });
    expect(gaps).toEqual([]);
  });

  it("registro mais antigo que a mensagem (além da tolerância) é buraco, ordenado do mais recente", () => {
    const gaps = findInboundGaps({
      now,
      chats: [
        { address: "+5591999990003", name: "A", lastMessageAt: minutesAgo(40) },
        { address: "+5591999990004", name: "B", lastMessageAt: minutesAgo(5) },
      ],
      known: new Map([
        ["+5591999990003", minutesAgo(50)],
        ["+5591999990004", minutesAgo(9)],
      ]),
    });
    expect(gaps.map((g) => g.name)).toEqual(["B", "A"]);
  });
});

describe("watchdogAlertBody", () => {
  it("lista até 5 chats com hora local e diz o que fazer", () => {
    const body = watchdogAlertBody(
      [
        { address: "+5591999991528", name: "Sogra", lastMessageAt: new Date("2026-09-16T22:50:00Z"), knownAt: null },
        { address: "x@lid", name: null, lastMessageAt: new Date("2026-09-16T22:40:00Z"), knownAt: null },
      ],
      "America/Belem",
    );
    expect(body).toContain("2 chats tiveram mensagem que NÃO chegou ao sistema");
    expect(body).toContain("• Sogra às 19:50");
    expect(body).toContain("• número oculto às 19:40");
    expect(body).toContain("responda pelo celular da loja");
  });
});
