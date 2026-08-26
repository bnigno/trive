// Matriz pura da origem exibida no painel: quem falou em cada mensagem —
// cliente, robô, dono (manual) ou automação. A ordem das regras é contrato.
import { describe, expect, it } from "vitest";

import {
  deriveWaMessageOrigin,
  type DeriveWaMessageOriginInput,
  type WaMessageOrigin,
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
