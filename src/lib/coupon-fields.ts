// Tradução entre o que a dona digita no painel de cupons e o que o serviço
// espera — PURO. "14:00" ↔ 840 minutos, dias da semana marcados, SKUs/slugs
// um por linha.

/** "14:00" → 840; "24:00" → 1440 (fim exclusivo); inválido → null. */
export function parseTimeToMinutes(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/** 840 → "14:00"; 1440 → "24:00". */
export function minutesToTime(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export const WEEKDAY_OPTIONS = [
  { value: 0, label: "dom" },
  { value: 1, label: "seg" },
  { value: 2, label: "ter" },
  { value: 3, label: "qua" },
  { value: 4, label: "qui" },
  { value: 5, label: "sex" },
  { value: 6, label: "sáb" },
] as const;

/** Checkboxes marcados ("0".."6") → dias ordenados sem repetição; nenhum ou todos = null (vale todo dia). */
export function parseWeekdays(values: readonly (string | number)[]): number[] | null {
  const days = [...new Set(values.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return null;
  return days;
}

/** SKU ou slug, um por linha (vírgula também separa), sem repetição. */
export function parseProductRefs(raw: string): string[] {
  return [...new Set(raw.split(/[\n,;]+/).map((ref) => ref.trim()).filter((ref) => ref !== ""))];
}
