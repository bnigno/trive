/** 8000 → "8 kg"; 300 → "0,3 kg". */
export function formatKg(grams: number): string {
  return `${(grams / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} kg`;
}
