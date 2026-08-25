// Validação PURA da assinatura de webhooks do Mercado Pago (header x-signature).
// Sem I/O, sem env: recebe tudo por parâmetro — testável com vetores gerados.
import { createHmac, timingSafeEqual } from "node:crypto";

export type ValidateMpSignatureInput = {
  /** Header x-signature no formato "ts=...,v1=...". */
  xSignature: string | null | undefined;
  /** Header x-request-id. */
  xRequestId: string | null | undefined;
  /** data.id da query string da notificação. */
  dataId: string | null | undefined;
  /** MP_WEBHOOK_SECRET da aplicação. */
  secret: string;
  /**
   * Idade máxima aceita para o ts da assinatura, em segundos.
   * Default: SEM limite — o MP reenvia notificações antigas em retentativas
   * (horas ou dias depois) e rejeitar por idade causaria falsos negativos;
   * replay é inofensivo aqui porque inbound_events + dedupe do outbox já
   * garantem idempotência, e o processador reconsulta a API de qualquer forma.
   */
  toleranceSeconds?: number;
};

function parseXSignature(
  xSignature: string,
): { ts: string; v1: string } | null {
  const parts = new Map<string, string>();
  for (const segment of xSignature.split(",")) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex === -1) continue;
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    if (key && value) parts.set(key, value);
  }
  const ts = parts.get("ts");
  const v1 = parts.get("v1");
  if (!ts || !v1) return null;
  return { ts, v1 };
}

export function validateMpSignature(input: ValidateMpSignatureInput): boolean {
  const { xSignature, xRequestId, dataId, secret, toleranceSeconds } = input;
  if (!xSignature || !secret) return false;

  const parsed = parseXSignature(xSignature);
  if (!parsed) return false;
  const { ts, v1 } = parsed;

  if (toleranceSeconds !== undefined) {
    const tsSeconds = Number(ts);
    if (!Number.isFinite(tsSeconds)) return false;
    const ageSeconds = Math.abs(Date.now() / 1000 - tsSeconds);
    if (ageSeconds > toleranceSeconds) return false;
  }

  // Manifest conforme a documentação do MP:
  //   id:[data.id];request-id:[x-request-id];ts:[ts];
  // segmentos ausentes na notificação são omitidos do manifest, e data.id
  // alfanumérico entra em minúsculas.
  let manifest = "";
  if (dataId) {
    const normalizedDataId = /^[a-zA-Z0-9]+$/.test(dataId)
      ? dataId.toLowerCase()
      : dataId;
    manifest += `id:${normalizedDataId};`;
  }
  if (xRequestId) {
    manifest += `request-id:${xRequestId};`;
  }
  manifest += `ts:${ts};`;

  const expectedHex = createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  // Comparação em tempo constante sobre os bytes das strings hex; tamanhos
  // diferentes já invalidam (timingSafeEqual exige buffers do mesmo tamanho).
  const expectedBuffer = Buffer.from(expectedHex, "utf8");
  const receivedBuffer = Buffer.from(v1.toLowerCase(), "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
