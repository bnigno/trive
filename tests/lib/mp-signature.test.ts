import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { validateMpSignature } from "../../src/lib/mp-signature";

const SECRET = "test-webhook-secret-123";

function sign(manifest: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

function buildHeader(opts: {
  dataId: string;
  requestId: string;
  ts?: string;
  secret?: string;
}): { xSignature: string; xRequestId: string; dataId: string } {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const manifest = `id:${opts.dataId};request-id:${opts.requestId};ts:${ts};`;
  const v1 = sign(manifest, opts.secret);
  return {
    xSignature: `ts=${ts},v1=${v1}`,
    xRequestId: opts.requestId,
    dataId: opts.dataId,
  };
}

describe("validateMpSignature", () => {
  it("aceita assinatura válida gerada com o mesmo secret", () => {
    const vector = buildHeader({ dataId: "123456789", requestId: "req-abc-1" });
    expect(validateMpSignature({ ...vector, secret: SECRET })).toBe(true);
  });

  it("aceita header com espaços entre os pares (ts= ..., v1= ...)", () => {
    const ts = "1700000000";
    const manifest = `id:42;request-id:req-2;ts:${ts};`;
    const xSignature = ` ts = ${ts} , v1 = ${sign(manifest)} `;
    expect(
      validateMpSignature({
        xSignature,
        xRequestId: "req-2",
        dataId: "42",
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("normaliza dataId alfanumérico para minúsculas no manifest", () => {
    const ts = "1700000000";
    // MP manda o manifest com o data.id minúsculo quando alfanumérico.
    const manifest = `id:abc123def;request-id:req-3;ts:${ts};`;
    const xSignature = `ts=${ts},v1=${sign(manifest)}`;
    expect(
      validateMpSignature({
        xSignature,
        xRequestId: "req-3",
        dataId: "ABC123DEF",
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejeita assinatura gerada com outro secret", () => {
    const vector = buildHeader({
      dataId: "123",
      requestId: "req-4",
      secret: "outro-secret",
    });
    expect(validateMpSignature({ ...vector, secret: SECRET })).toBe(false);
  });

  it("rejeita quando o dataId foi adulterado", () => {
    const vector = buildHeader({ dataId: "123", requestId: "req-5" });
    expect(
      validateMpSignature({ ...vector, dataId: "999", secret: SECRET }),
    ).toBe(false);
  });

  it("rejeita v1 de tamanho diferente sem lançar", () => {
    const vector = buildHeader({ dataId: "123", requestId: "req-6" });
    const truncated = vector.xSignature.slice(0, -10);
    expect(
      validateMpSignature({ ...vector, xSignature: truncated, secret: SECRET }),
    ).toBe(false);
  });

  it("rejeita header malformado (sem ts/v1, vazio, null)", () => {
    const base = { xRequestId: "req-7", dataId: "123", secret: SECRET };
    expect(validateMpSignature({ ...base, xSignature: "banana" })).toBe(false);
    expect(validateMpSignature({ ...base, xSignature: "ts=123" })).toBe(false);
    expect(validateMpSignature({ ...base, xSignature: "v1=abc" })).toBe(false);
    expect(validateMpSignature({ ...base, xSignature: "" })).toBe(false);
    expect(validateMpSignature({ ...base, xSignature: null })).toBe(false);
    expect(validateMpSignature({ ...base, xSignature: undefined })).toBe(false);
  });

  it("sem toleranceSeconds aceita ts antigo (default sem limite)", () => {
    const vector = buildHeader({
      dataId: "123",
      requestId: "req-8",
      ts: "1500000000", // bem no passado
    });
    expect(validateMpSignature({ ...vector, secret: SECRET })).toBe(true);
  });

  it("com toleranceSeconds rejeita ts fora da janela e aceita dentro dela", () => {
    const old = buildHeader({
      dataId: "123",
      requestId: "req-9",
      ts: String(Math.floor(Date.now() / 1000) - 3600),
    });
    expect(
      validateMpSignature({ ...old, secret: SECRET, toleranceSeconds: 300 }),
    ).toBe(false);

    const fresh = buildHeader({ dataId: "123", requestId: "req-9" });
    expect(
      validateMpSignature({ ...fresh, secret: SECRET, toleranceSeconds: 300 }),
    ).toBe(true);
  });

  it("segmentos ausentes saem do manifest (sem dataId)", () => {
    const ts = "1700000000";
    const manifest = `request-id:req-10;ts:${ts};`;
    const xSignature = `ts=${ts},v1=${sign(manifest)}`;
    expect(
      validateMpSignature({
        xSignature,
        xRequestId: "req-10",
        dataId: null,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("secret vazio rejeita sempre", () => {
    const vector = buildHeader({ dataId: "123", requestId: "req-11" });
    expect(validateMpSignature({ ...vector, secret: "" })).toBe(false);
  });
});
