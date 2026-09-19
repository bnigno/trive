// Matriz pura da origem exibida no painel: quem falou em cada mensagem —
// cliente, robô, dono (manual) ou automação. A ordem das regras é contrato.
import { describe, expect, it } from "vitest";

import {
  deriveWaMessageOrigin,
  isProactiveBotReply,
  type DeriveWaMessageOriginInput,
  type WaMessageOrigin,
  answeredInboundId,
  answeredInboundOf,
  manualReplyDedupeKey,
  orderHistoryRows,
  pendingInboundRows,
} from "@/core/whatsapp/origin";

describe("deriveWaMessageOrigin", () => {
  const cases: Array<[string, DeriveWaMessageOriginInput, WaMessageOrigin]> = [
    [
      "inbound é sempre do cliente",
      { direction: "inbound", templateKey: null, dedupeKey: null },
      "customer",
    ],
    [
      "inbound vence qualquer outra pista (defensivo)",
      {
        direction: "inbound",
        templateKey: "order_confirmed_client",
        dedupeKey: "wa.bot_reply:x",
      },
      "customer",
    ],
    [
      "resposta do robô (wa.bot_reply)",
      { direction: "outbound", templateKey: null, dedupeKey: "wa.bot_reply:m1" },
      "bot",
    ],
    [
      "mídia do robô (wa.bot_media)",
      {
        direction: "outbound",
        templateKey: null,
        dedupeKey: "wa.bot_media:m1:0",
      },
      "bot",
    ],
    [
      "aviso de transferência do robô (wa.bot_handoff_notice)",
      {
        direction: "outbound",
        templateKey: null,
        dedupeKey: "wa.bot_handoff_notice:m1",
      },
      "bot",
    ],
    [
      "envio manual do dono pelo painel (wa.send:)",
      { direction: "outbound", templateKey: null, dedupeKey: "wa.send:evt-1" },
      "manual",
    ],
    [
      "notificação com template é automática",
      {
        direction: "outbound",
        templateKey: "order_confirmed_client",
        dedupeKey: "wa.order_confirmed:order-1",
      },
      "auto",
    ],
    [
      "template sem dedupe também é automática",
      {
        direction: "outbound",
        templateKey: "owner_low_stock",
        dedupeKey: null,
      },
      "auto",
    ],
    [
      "outbound sem assinatura conhecida cai em auto",
      { direction: "outbound", templateKey: null, dedupeKey: null },
      "auto",
    ],
    [
      "dedupe desconhecido sem template cai em auto",
      { direction: "outbound", templateKey: null, dedupeKey: "wa.low:v1" },
      "auto",
    ],
  ];

  it.each(cases)("%s", (_label, input, expected) => {
    expect(deriveWaMessageOrigin(input)).toBe(expected);
  });

  it("wa.bot_* vence sobre template presente (ordem das regras)", () => {
    expect(
      deriveWaMessageOrigin({
        direction: "outbound",
        templateKey: "qualquer",
        dedupeKey: "wa.bot_reply:m9",
      }),
    ).toBe("bot");
  });
});

describe("isProactiveBotReply", () => {
  it("só o dedupe do turno proativo (wa.bot_reply:followup:<id>) conta — e ele continua com origem 'bot'", () => {
    expect(isProactiveBotReply("wa.bot_reply:followup:0b16429e-72de-49d4-bd55-c9d4b87df002")).toBe(true);
    expect(isProactiveBotReply("wa.bot_reply:followup:0b16429e-72de-49d4-bd55-c9d4b87df002:1")).toBe(true);
    expect(isProactiveBotReply("wa.bot_reply:0b16429e-72de-49d4-bd55-c9d4b87df002")).toBe(false);
    expect(isProactiveBotReply("wa.bot_media:followup:x:0")).toBe(false);
    expect(isProactiveBotReply(null)).toBe(false);
    expect(deriveWaMessageOrigin({ direction: "outbound", templateKey: null, dedupeKey: "wa.bot_reply:followup:x" })).toBe("bot");
  });
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const t = (seconds: number) => new Date(Date.UTC(2026, 8, 19, 8, 48, seconds));

describe("answeredInboundId", () => {
  it("lê a inbound respondida do dedupe da resposta e da mídia; retorno combinado e envios da loja não respondem a nada", () => {
    expect(answeredInboundId(`wa.bot_reply:${A}`)).toBe(A);
    expect(answeredInboundId(`wa.bot_reply:${A}:1`)).toBe(A);
    expect(answeredInboundId(`wa.bot_media:${A}:0`)).toBe(A);
    expect(answeredInboundId(`wa.bot_media:${A}:card`)).toBe(A);
    expect(answeredInboundId(`wa.bot_handoff_notice:${A}`)).toBe(A);
    expect(answeredInboundId("wa.bot_reply:suggestion:22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(answeredInboundId("wa.bot_reply:followup:abc")).toBeNull();
    expect(answeredInboundId("wa.send:manual-1")).toBeNull();
    // Resposta da equipe pelo painel leva a mensagem dela que estava na tela.
    expect(answeredInboundId(manualReplyDedupeKey("e1", A))).toBe(A);
    expect(manualReplyDedupeKey("e1", A)).toBe(`wa.send:e1:re:${A}`);
    expect(manualReplyDedupeKey("e1", null)).toBe("wa.send:e1");
    expect(deriveWaMessageOrigin({ direction: "outbound", dedupeKey: manualReplyDedupeKey("e1", A), templateKey: null })).toBe("manual");
    expect(answeredInboundId("order.paid:xyz")).toBeNull();
    expect(answeredInboundId(null)).toBeNull();
  });
});

describe("orderHistoryRows", () => {
  it("a resposta cola na inbound que respondeu; a mensagem que chegou enquanto o modelo pensava fica por último (caso real de 19/09)", () => {
    const rows = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(20), body: "Mercadinho camarada" },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(23), body: "9" },
      { id: C, direction: "inbound", dedupeKey: null, createdAt: t(33), body: "Não precisa de nota" },
      { id: "r", direction: "outbound", dedupeKey: `wa.bot_reply:${B}`, createdAt: t(34), body: "Combinado, motoboy amanhã 9h–12h…" },
    ];
    expect(orderHistoryRows(rows).map((row) => row.id)).toEqual([A, B, "r", C]);
  });

  it("resposta sem inbound conhecida (cartão atrasado, retorno combinado, equipe, aviso) fica na hora em que saiu; ordem estável", () => {
    const rows = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: "card", direction: "outbound", dedupeKey: "wa.bot_media:99999999-9999-4999-8999-999999999999:0", createdAt: t(2) },
      { id: "auto", direction: "outbound", dedupeKey: "order.paid:1", createdAt: t(3) },
      { id: "r", direction: "outbound", dedupeKey: `wa.bot_reply:${A}`, createdAt: t(4) },
      { id: "pro", direction: "outbound", dedupeKey: "wa.bot_reply:followup:f1", createdAt: t(5) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(6) },
    ];
    expect(orderHistoryRows(rows).map((row) => row.id)).toEqual([A, "r", "card", "auto", "pro", B]);
    // Saída sem inbound conhecida DEPOIS da última mensagem da cliente (cartão de
    // turno antigo, retorno combinado, aviso, equipe) vai para logo antes dela: a
    // conversa termina com a cliente — que pode ter escrito enquanto o modelo pensava.
    const tail = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: "r", direction: "outbound", dedupeKey: `wa.bot_reply:${A}`, createdAt: t(2) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(3) },
      { id: "card", direction: "outbound", dedupeKey: "wa.bot_media:99999999-9999-4999-8999-999999999999:card", createdAt: t(5) },
      { id: "pro", direction: "outbound", dedupeKey: "wa.bot_reply:followup:f1", createdAt: t(6) },
      { id: "auto", direction: "outbound", dedupeKey: "order.paid:1", createdAt: t(7) },
    ];
    expect(orderHistoryRows(tail).map((row) => row.id)).toEqual([A, "r", "card", "pro", B, "auto"]);
    // Sugestão aprovada: a inbound respondida vem de fora (tabela de sugestões) e ancora como uma resposta.
    const suggestion = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(3) },
      { id: "s", direction: "outbound", dedupeKey: "wa.bot_reply:suggestion:22222222-2222-4222-8222-222222222222", createdAt: t(5), answers: A },
    ];
    expect(orderHistoryRows(suggestion).map((row) => row.id)).toEqual([A, "s", B]);
    expect(answeredInboundOf(suggestion[2])).toBe(A);
    expect(answeredInboundOf({ direction: "inbound", dedupeKey: null })).toBeNull();
    expect(answeredInboundOf({ direction: "outbound", dedupeKey: `wa.bot_reply:${B}` })).toBe(B);
    // Aviso automático e resposta da equipe (viram fala de usuário) ficam na ordem em que saíram, mesmo depois da última mensagem dela.
    const staff = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: "r", direction: "outbound", dedupeKey: `wa.bot_reply:${A}`, createdAt: t(2) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(3) },
      { id: "m", direction: "outbound", dedupeKey: "wa.send:e9", createdAt: t(4) },
      { id: "auto", direction: "outbound", dedupeKey: "order.paid:1", templateKey: "order_paid", createdAt: t(5) },
    ];
    expect(orderHistoryRows(staff).map((row) => row.id)).toEqual([A, "r", B, "m", "auto"]);
    // Empate de milissegundo com a última inbound: a saída da Lia sem âncora também vai para antes dela.
    const tie = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: "r", direction: "outbound", dedupeKey: `wa.bot_reply:${A}`, createdAt: t(2) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(3) },
      { id: "pro", direction: "outbound", dedupeKey: "wa.bot_reply:followup:f1", createdAt: t(3) },
    ];
    expect(orderHistoryRows(tie).map((row) => row.id)).toEqual([A, "r", "pro", B]);
    // Sem nenhuma inbound, nada muda.
    expect(orderHistoryRows([{ id: "x", direction: "outbound", dedupeKey: "order.paid:1", createdAt: t(1) }]).map((row) => row.id)).toEqual(["x"]);
    // Dois balões da mesma resposta mantêm a ordem entre si.
    const bubbles = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: "b1", direction: "outbound", dedupeKey: `wa.bot_reply:${A}`, createdAt: t(9) },
      { id: "b2", direction: "outbound", dedupeKey: `wa.bot_reply:${A}:1`, createdAt: t(9) },
    ];
    expect(orderHistoryRows(bubbles).map((row) => row.id)).toEqual([A, "b1", "b2"]);
  });
});

describe("pendingInboundRows", () => {
  it("resposta ancorada cobre até a inbound dela; manual da equipe cobre o que veio antes; aviso, cartão antigo e retorno não cobrem", () => {
    const rows = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(1) },
      { id: "r", direction: "outbound", dedupeKey: `wa.bot_reply:${A}`, createdAt: t(4) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(2) },
      { id: C, direction: "inbound", dedupeKey: null, createdAt: t(5) },
    ];
    // B chegou entre A e a resposta de A: ainda pendente, como C.
    expect(pendingInboundRows(rows).map((row) => row.id)).toEqual([B, C]);
    const manual = [...rows, { id: "m", direction: "outbound", dedupeKey: "wa.send:1", createdAt: t(6) }];
    expect(pendingInboundRows(manual)).toEqual([]);
    // A resposta manual sem âncora cobre o que chegou antes do CLIQUE (repliedAt), não o que a fila entregou depois.
    const clicked = [...rows, { id: "m", direction: "outbound", dedupeKey: "wa.send:1", createdAt: t(6), repliedAt: t(3) }];
    expect(pendingInboundRows(clicked).map((row) => row.id)).toEqual([C]);
    // Ancorada na mensagem vista (`:re:`): cobre até ela — mesmo uma mensagem com hora anterior que a dona não viu (presa na trava do turno) fica pendente.
    const seen = [
      { id: A, direction: "inbound", dedupeKey: null, createdAt: t(0) },
      { id: B, direction: "inbound", dedupeKey: null, createdAt: t(5) },
      { id: "m", direction: "outbound", dedupeKey: manualReplyDedupeKey("e2", A), createdAt: t(8) },
    ];
    expect(pendingInboundRows(seen).map((row) => row.id)).toEqual([B]);
    expect(orderHistoryRows(seen).map((row) => row.id)).toEqual([A, "m", B]);
    const auto = [...rows, { id: "auto", direction: "outbound", dedupeKey: "order.paid:1", templateKey: "order_paid", createdAt: t(6) }];
    expect(pendingInboundRows(auto).map((row) => row.id)).toEqual([B, C]);
    const late = [...rows, { id: "card", direction: "outbound", dedupeKey: "wa.bot_media:99999999-9999-4999-8999-999999999999:card", createdAt: t(6) }, { id: "pro", direction: "outbound", dedupeKey: "wa.bot_reply:followup:f", createdAt: t(7) }];
    expect(pendingInboundRows(late).map((row) => row.id)).toEqual([B, C]);
    const suggestion = [...rows, { id: "s", direction: "outbound", dedupeKey: "wa.bot_reply:suggestion:22222222-2222-4222-8222-222222222222", createdAt: t(6), answers: C }];
    expect(pendingInboundRows(suggestion)).toEqual([]);
    expect(pendingInboundRows([])).toEqual([]);
  });
});
