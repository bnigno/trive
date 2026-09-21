// De onde veio a invocação que processou um evento do outbox. Vai no evento e
// nos tempos do turno da Lia: é o que diz se a resposta saiu na mesma chamada
// do webhook (inline), pelo aviso ao Inngest (kick) ou pela varredura (cron).
export type OutboxSource = "inline" | "kick" | "cron";

export const OUTBOX_SOURCES: readonly OutboxSource[] = ["inline", "kick", "cron"];

/** Rótulos curtos para o painel. */
export const OUTBOX_SOURCE_LABELS: Record<OutboxSource | "unknown", string> = {
  inline: "na hora",
  kick: "pelo aviso ao Inngest",
  cron: "pelo cron",
  unknown: "sem origem registrada",
};
