// A política de envio proativo no WhatsApp, num lugar só: janela (9–21 no
// relógio de São Paulo, ajustável), intervalo entre mensagens em massa e o
// adiamento datado de quem chegou fora da hora. Usada por avisos de estoque,
// convites e a lista da estreia — nunca uma rajada, nunca de madrugada.

import {
  DEFAULT_BULK_INTERVAL_SECONDS,
  DEFAULT_SEND_WINDOW,
  isWithinSendWindow,
  nextSendWindowStart,
  type SendWindow,
} from "@/core/whatsapp/send-window";
import { spDayKey } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";

export type SendPolicy = { window: SendWindow; intervalSeconds: number };

export async function loadSendPolicy(db: DbOrTx): Promise<SendPolicy> {
  const map = await getSettingsMap(db, ["wa_send_window_start", "wa_send_window_end", "wa_bulk_interval_seconds"]);
  const start = Number(map["wa_send_window_start"]);
  const end = Number(map["wa_send_window_end"]);
  const interval = Number(map["wa_bulk_interval_seconds"]);
  return {
    window: {
      startHour: Number.isFinite(start) ? start : DEFAULT_SEND_WINDOW.startHour,
      endHour: Number.isFinite(end) ? end : DEFAULT_SEND_WINDOW.endHour,
    },
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_BULK_INTERVAL_SECONDS,
  };
}

export type DeferInput = {
  eventType: string;
  /** Base do dedupe; o dia de São Paulo é acrescentado (no máximo um adiamento por dia). */
  dedupeBase: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  now: Date;
};

/**
 * Fora da janela? Re-enfileira o mesmo evento para a abertura da janela com
 * dedupe datado e devolve true (o handler encerra com "fora_da_janela").
 * Dentro da janela devolve false e nada acontece.
 */
export async function deferOutsideSendWindow(db: DbOrTx, policy: SendPolicy, input: DeferInput): Promise<boolean> {
  if (isWithinSendWindow(input.now, policy.window)) return false;
  await enqueueOutboxEvent(db, {
    eventType: input.eventType,
    dedupeKey: `${input.dedupeBase}:${spDayKey(input.now)}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    nextAttemptAt: nextSendWindowStart(input.now, policy.window),
  });
  return true;
}
