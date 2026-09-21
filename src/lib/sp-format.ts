// Formatação de data/hora para a tela, sempre em America/Sao_Paulo. Puro.
// (O "dia" para cálculo é o de sp-day.ts; aqui é só a borda de exibição.)

const SP_TIME_ZONE = "America/Sao_Paulo";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: SP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: SP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "21/09/2026" */
export function formatDateSP(date: Date): string {
  return dateFormatter.format(date);
}

/** "21/09/2026, 10:52" */
export function formatDateTimeSP(date: Date): string {
  return dateTimeFormatter.format(date);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias"; depois de uma semana
 * vira a data. Para "visto por último" e "quando" de listas — a data exata
 * vai no `title`. Data no futuro (relógios desalinhados) conta como agora.
 */
export function formatRelativeTimePtBR(date: Date, now: Date): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return "agora";
  if (elapsed < HOUR_MS) return `há ${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) return `há ${Math.floor(elapsed / HOUR_MS)} h`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  return formatDateSP(date);
}
