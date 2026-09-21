// Saúde do Provador: o que decide pausar a sala (kill switch), quantas vezes a
// Lia pode responder no grupo por hora e quando um aviso de "ficou a última
// no seu tamanho" pode sair de novo. Números pequenos e explícitos — a regra
// é não incomodar. Puro.

export const DEFAULT_KILL_SWITCH_PCT = 2;
/** Menos saídas que isto nunca pausam: uma pessoa saindo não é sinal. */
export const KILL_SWITCH_MIN_LEAVES = 2;
export const DEFAULT_MENTION_REPLIES_PER_HOUR = 5;
export const DEFAULT_LAST_UNIT_NOTICE_DAYS = 7;
/** Resposta da Lia no grupo: 2 linhas, sem muro de texto. */
export const MENTION_REPLY_MAX_CHARS = 280;

/**
 * Pausar a sala? Quando as saídas nas 24 h após um post passam de `pct`% das
 * membras — e são pelo menos KILL_SWITCH_MIN_LEAVES. `pct` 0 desliga.
 */
export function shouldTripKillSwitch(input: { leaves: number; members: number; pct: number }): boolean {
  if (input.pct <= 0 || input.members <= 0) return false;
  if (input.leaves < KILL_SWITCH_MIN_LEAVES) return false;
  return (input.leaves / input.members) * 100 > input.pct;
}

/** A Lia ainda pode responder no grupo nesta hora? */
export function mentionReplyAllowed(input: { repliesLastHour: number; limit?: number }): boolean {
  return input.repliesLastHour < (input.limit ?? DEFAULT_MENTION_REPLIES_PER_HOUR);
}

/** Um aviso de "última no seu tamanho" por pessoa a cada N dias. */
export function lastUnitNoticeAllowed(input: { lastNoticeAt: Date | null; now: Date; minDays?: number }): boolean {
  if (!input.lastNoticeAt) return true;
  const minMs = (input.minDays ?? DEFAULT_LAST_UNIT_NOTICE_DAYS) * 86_400_000;
  return input.now.getTime() - input.lastNoticeAt.getTime() >= minMs;
}

/**
 * Corta a resposta do modelo para caber no grupo: no máximo 2 linhas e
 * MENTION_REPLY_MAX_CHARS; linhas de cabeçalho markdown e separadores
 * (---) caem fora. Corte em frase quando dá; senão em palavra, com
 * reticência.
 */
export function clampMentionReply(text: string, maxChars: number = MENTION_REPLY_MAX_CHARS): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "---" && !line.startsWith("#"));
  let joined = lines.slice(0, 2).join("\n");
  if (joined.length <= maxChars) return joined;
  joined = joined.slice(0, maxChars);
  const lastSentence = Math.max(joined.lastIndexOf(". "), joined.lastIndexOf("? "), joined.lastIndexOf("! "));
  if (lastSentence >= maxChars * 0.5) return joined.slice(0, lastSentence + 1).trim();
  const lastSpace = joined.lastIndexOf(" ");
  return `${(lastSpace > 0 ? joined.slice(0, lastSpace) : joined).trim()}…`;
}
