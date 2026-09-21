import { describe, expect, it } from "vitest";

import { formatDateSP, formatDateTimeSP, formatRelativeTimePtBR } from "@/lib/sp-format";

describe("sp-format", () => {
  it("formata data e data-hora no fuso de São Paulo", () => {
    // 02:30Z de 22/09 ainda é 23:30 de 21/09 em SP.
    const date = new Date("2026-09-22T02:30:00Z");
    expect(formatDateSP(date)).toBe("21/09/2026");
    expect(formatDateTimeSP(date)).toBe("21/09/2026, 23:30");
  });

  it("tempo relativo em português, com a data depois de uma semana", () => {
    const now = new Date("2026-09-21T15:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(formatRelativeTimePtBR(now, now)).toBe("agora");
    expect(formatRelativeTimePtBR(ago(30_000), now)).toBe("agora");
    expect(formatRelativeTimePtBR(ago(5 * 60_000), now)).toBe("há 5 min");
    expect(formatRelativeTimePtBR(ago(2 * 3_600_000), now)).toBe("há 2 h");
    expect(formatRelativeTimePtBR(ago(26 * 3_600_000), now)).toBe("ontem");
    expect(formatRelativeTimePtBR(ago(3 * 86_400_000), now)).toBe("há 3 dias");
    expect(formatRelativeTimePtBR(ago(7 * 86_400_000), now)).toBe("14/09/2026");
  });

  it("data no futuro conta como agora", () => {
    const now = new Date("2026-09-21T15:00:00Z");
    expect(formatRelativeTimePtBR(new Date(now.getTime() + 60_000), now)).toBe("agora");
  });
});
