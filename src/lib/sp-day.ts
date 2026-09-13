// O "dia" como o dono vive: America/Sao_Paulo, UTC−3 fixo (o Brasil não tem
// horário de verão desde 2019). Uma venda paga às 23h30 em SP é 02h30 UTC do
// dia seguinte e precisa contar no dia em que aconteceu. Puro: só datas.

const SP_TIME_ZONE = "America/Sao_Paulo";
const SP_OFFSET = "-03:00";
const DAY_MS = 86_400_000;

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabelFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: SP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

const weekdayFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: SP_TIME_ZONE,
  weekday: "long",
});

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isSpDayKey(value: string): boolean {
  return DAY_KEY_PATTERN.test(value);
}

const hourMinuteFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SP_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Minutos desde 00:00 no relógio de parede de São Paulo (0–1439). */
export function spMinutesOfDay(date: Date): number {
  const [hh, mm] = hourMinuteFormatter.format(date).split(":").map(Number);
  return ((hh % 24) * 60) + mm;
}

/** 'YYYY-MM-DD' do instante, no dia de São Paulo. */
export function spDayKey(date: Date): string {
  return dayKeyFormatter.format(date);
}

/** Meia-noite de São Paulo do dia, como instante UTC (03:00Z). */
export function spDayStart(key: string): Date {
  if (!isSpDayKey(key)) throw new RangeError(`Dia inválido: ${key}`);
  return new Date(`${key}T00:00:00${SP_OFFSET}`);
}

/** Primeiro instante do dia seguinte (limite exclusivo da janela). */
export function spDayEnd(key: string): Date {
  return spDayStart(spNextDayKey(key));
}

export function spNextDayKey(key: string): string {
  return spDayKey(new Date(spDayStart(key).getTime() + DAY_MS + DAY_MS / 2));
}

export function spPreviousDayKey(key: string): string {
  return spDayKey(new Date(spDayStart(key).getTime() - DAY_MS / 2));
}

/** 0 = domingo … 6 = sábado, no calendário de São Paulo. */
export function weekdayIndexSP(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "quarta-feira, 9 de setembro". */
export function spDayLabel(key: string): string {
  return dayLabelFormatter.format(new Date(spDayStart(key).getTime() + DAY_MS / 2));
}

/** "quarta-feira". */
export function spWeekdayName(key: string): string {
  return weekdayFormatter.format(new Date(spDayStart(key).getTime() + DAY_MS / 2));
}
