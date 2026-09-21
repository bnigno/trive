// O avisador do painel (mensagem nova em qualquer página): o schema do poll
// leve, o que é "novo" entre dois polls, o ritmo, o texto do aviso e o
// prefixo "(N)" do título.
import { describe, expect, it } from "vitest";

import {
  freshUnseen,
  IDLE_AFTER_MS,
  notificationFor,
  pollDelayMs,
  rememberUnseen,
  toastTitleFor,
  withUnreadPrefix,
} from "@/app/admin/(protected)/admin-notifier-logic";
import { filterFromParam } from "@/app/admin/(protected)/whatsapp/conversas/conversation-list";
import {
  inboundPreview,
  lightPollResponseSchema,
  type LightPollUnseen,
} from "@/app/admin/(protected)/whatsapp/conversas/poll/light-schema";

function unseen(overrides: Partial<LightPollUnseen> = {}): LightPollUnseen {
  return {
    id: "c1",
    label: "Ana",
    status: "open",
    awaitingOwner: false,
    preview: "tem em M?",
    lastInboundAt: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}

describe("poll leve: schema e prévia", () => {
  it("aceita a resposta da rota e recusa número negativo ou campo faltando", () => {
    const ok = lightPollResponseSchema.safeParse({
      serverTime: "2026-09-21T12:00:00.000Z",
      awaitingOwner: 1,
      withNewMessages: 3,
      unseen: [unseen()],
      suggestionCount: 0,
      suggestions: [],
    });
    expect(ok.success).toBe(true);

    expect(lightPollResponseSchema.safeParse({ serverTime: "x", awaitingOwner: -1, withNewMessages: 0, unseen: [], suggestionCount: 0, suggestions: [] }).success).toBe(false);
    expect(lightPollResponseSchema.safeParse({ serverTime: "x", humanCount: 1, awaiting: [] }).success).toBe(false);
    expect(lightPollResponseSchema.safeParse({ serverTime: "x", awaitingOwner: 0, withNewMessages: 0, unseen: [{ id: "c1" }], suggestionCount: 0, suggestions: [] }).success).toBe(false);
    // Sem `awaitingOwner` no item (formato antigo, só `status`): recusa — o cliente não pode chutar.
    expect(lightPollResponseSchema.safeParse({ serverTime: "x", awaitingOwner: 0, withNewMessages: 0, unseen: [{ id: "c1", label: "Ana", status: "human", preview: null, lastInboundAt: null }], suggestionCount: 0, suggestions: [] }).success).toBe(false);
  });

  it("prévia: uma linha, sem espaços repetidos, no máximo 120 caracteres; vazio vira null", () => {
    expect(inboundPreview("  tem \n em   M? ")).toBe("tem em M?");
    expect(inboundPreview("")).toBeNull();
    expect(inboundPreview("   ")).toBeNull();
    expect(inboundPreview(null)).toBeNull();
    const long = "a".repeat(200);
    const preview = inboundPreview(long);
    expect(preview).toHaveLength(120);
    expect(preview?.endsWith("…")).toBe(true);
    expect(inboundPreview("a".repeat(120))).toBe("a".repeat(120));
  });
});

describe("freshUnseen: uma vez por mensagem", () => {
  it("conversa que não estava é nova; a mesma mensagem de novo não é", () => {
    const first = [unseen()];
    expect(freshUnseen(rememberUnseen([]), first).map((item) => item.id)).toEqual(["c1"]);
    expect(freshUnseen(rememberUnseen(first), first)).toEqual([]);
  });

  it("mensagem mais recente na mesma conversa é nova; relógio para trás não é", () => {
    const known = rememberUnseen([unseen()]);
    expect(freshUnseen(known, [unseen({ lastInboundAt: "2026-09-21T12:05:00.000Z" })])).toHaveLength(1);
    expect(freshUnseen(known, [unseen({ lastInboundAt: "2026-09-21T11:00:00.000Z" })])).toEqual([]);
    expect(freshUnseen(known, [unseen({ lastInboundAt: null })])).toEqual([]);
  });

  it("a mesma mensagem passando para o dono é nova (a transferência merece aviso); já com o dono → não", () => {
    const known = rememberUnseen([unseen({ awaitingOwner: false })]);
    expect(freshUnseen(known, [unseen({ awaitingOwner: true, status: "human" })])).toHaveLength(1);
    expect(freshUnseen(rememberUnseen([unseen({ awaitingOwner: true })]), [unseen({ awaitingOwner: true })])).toEqual([]);
    // Devolvida à vendedora com a mesma mensagem: nada a avisar.
    expect(freshUnseen(rememberUnseen([unseen({ awaitingOwner: true })]), [unseen({ awaitingOwner: false })])).toEqual([]);
  });

  it("quem saiu da lista (foi lida) e voltou com outra mensagem conta de novo", () => {
    let known = rememberUnseen([unseen()]);
    // Lida: o poll seguinte vem sem ela.
    expect(freshUnseen(known, [])).toEqual([]);
    known = rememberUnseen([]);
    expect(freshUnseen(known, [unseen({ lastInboundAt: "2026-09-21T13:00:00.000Z" })])).toHaveLength(1);
  });
});

describe("ritmo do poll", () => {
  it("10 s em uso, 30 s parado há 10 min, 60 s com a aba escondida; erro dobra até 60 s", () => {
    expect(pollDelayMs({ hidden: false, idleForMs: 0, failures: 0 })).toBe(10_000);
    expect(pollDelayMs({ hidden: false, idleForMs: IDLE_AFTER_MS - 1, failures: 0 })).toBe(10_000);
    expect(pollDelayMs({ hidden: false, idleForMs: IDLE_AFTER_MS, failures: 0 })).toBe(30_000);
    expect(pollDelayMs({ hidden: true, idleForMs: 0, failures: 0 })).toBe(60_000);
    expect(pollDelayMs({ hidden: false, idleForMs: 0, failures: 1 })).toBe(20_000);
    expect(pollDelayMs({ hidden: false, idleForMs: 0, failures: 2 })).toBe(40_000);
    expect(pollDelayMs({ hidden: false, idleForMs: 0, failures: 5 })).toBe(60_000);
    expect(pollDelayMs({ hidden: true, idleForMs: 0, failures: 3 })).toBe(60_000);
  });
});

describe("texto do aviso", () => {
  it("toast: 'Nova mensagem de' para a vendedora atendendo; 'esperando por você' quando é com o dono", () => {
    expect(toastTitleFor(unseen())).toBe("Nova mensagem de Ana");
    expect(toastTitleFor(unseen({ awaitingOwner: true }))).toBe("Ana está esperando por você");
    // Vendedora desligada: a conversa continua 'open', mas é com você.
    expect(toastTitleFor(unseen({ status: "open", awaitingOwner: true }))).toBe("Ana está esperando por você");
  });

  it("aviso de sistema: um por lote — singular com prévia, plural com até 3 nomes", () => {
    expect(notificationFor([])).toBeNull();
    expect(notificationFor([unseen()])).toEqual({ title: "Nova mensagem de Ana", body: "tem em M?", conversationId: "c1" });
    expect(notificationFor([unseen({ preview: null, awaitingOwner: true })])).toEqual({ title: "Ana está esperando por você", body: undefined, conversationId: "c1" });
    const many = ["Ana", "Bia", "Carla", "Dani", "Eva"].map((label, index) => unseen({ id: `c${index}`, label }));
    expect(notificationFor(many)).toEqual({ title: "5 conversas com mensagem nova", body: "Ana, Bia, Carla e mais 2", conversationId: "c0" });
    expect(notificationFor(many.slice(0, 2))?.body).toBe("Ana, Bia");
  });

  it("só sugestão da vendedora: também avisa, uma vez por lote", () => {
    expect(notificationFor([], [{ id: "c9", label: "Ana" }])).toEqual({ title: "A vendedora sugeriu uma resposta", body: "Ana", conversationId: "c9" });
    expect(notificationFor([], [{ id: "c9", label: "Ana" }, { id: "c8", label: "Bia" }])?.title).toBe("2 sugestões da vendedora");
  });
});

describe("título da aba e filtro pela URL", () => {
  it("prefixa, troca o prefixo antigo e tira com zero", () => {
    expect(withUnreadPrefix("Pedidos | TRIVÉ", 3)).toBe("(3) Pedidos | TRIVÉ");
    expect(withUnreadPrefix("(3) Pedidos | TRIVÉ", 5)).toBe("(5) Pedidos | TRIVÉ");
    expect(withUnreadPrefix("(3) Pedidos | TRIVÉ", 0)).toBe("Pedidos | TRIVÉ");
    expect(withUnreadPrefix("Pedidos | TRIVÉ", 0)).toBe("Pedidos | TRIVÉ");
  });

  it("?f=nao-lidas abre o filtro Não lidas; valor desconhecido cai em Todas", () => {
    expect(filterFromParam("nao-lidas")).toBe("unread");
    expect(filterFromParam("com-voce")).toBe("you");
    expect(filterFromParam("encerradas")).toBe("closed");
    expect(filterFromParam("qualquer")).toBe("all");
    expect(filterFromParam(null)).toBe("all");
  });
});
