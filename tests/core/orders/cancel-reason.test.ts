import { describe, expect, it } from "vitest";

import {
  CANCEL_REASON_MAX_CHARS,
  friendlyCancelReason,
  RESERVATION_EXPIRED_REASON,
} from "@/core/orders/reasons";

describe("friendlyCancelReason", () => {
  it("expiração de reserva vira frase humana, sem o texto técnico", () => {
    const text = friendlyCancelReason(RESERVATION_EXPIRED_REASON);
    expect(text).toBe("o prazo de pagamento terminou e a reserva foi liberada");
    expect(text).not.toContain("Reserva expirada");
  });

  it("motivo da dona é limpo e truncado com reticências", () => {
    expect(friendlyCancelReason("  cliente   desistiu\nda compra ")).toBe("cliente desistiu da compra");
    const longo = "x".repeat(CANCEL_REASON_MAX_CHARS + 50);
    const result = friendlyCancelReason(longo);
    expect(result).toHaveLength(CANCEL_REASON_MAX_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("vazio ou nulo cai no fallback", () => {
    expect(friendlyCancelReason(null)).toBe("a pedido da loja");
    expect(friendlyCancelReason("   ")).toBe("a pedido da loja");
  });
});
