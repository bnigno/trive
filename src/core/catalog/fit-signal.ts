// O sinal de caimento por tamanho — PURO. Com poucas respostas não se
// afirma nada; a partir de `min` respostas com opinião sobre o caimento
// (amei, grande ou pequeno), se `ratio` delas disseram "ficou grande" (ou
// "pequeno"), a peça "veste grande" (ou "pequeno") naquele tamanho.

export type FitSignal = "veste_grande" | "veste_pequeno";

export type FitCounts = { amei: number; grande: number; pequeno: number };

export const FIT_SIGNAL_MIN = 3;
export const FIT_SIGNAL_RATIO = 0.6;

export function fitSignal(counts: FitCounts, opts: { min?: number; ratio?: number } = {}): FitSignal | null {
  const min = opts.min ?? FIT_SIGNAL_MIN;
  const ratio = opts.ratio ?? FIT_SIGNAL_RATIO;
  const total = counts.amei + counts.grande + counts.pequeno;
  if (total < min) return null;
  if (counts.grande / total >= ratio && counts.grande > counts.pequeno) return "veste_grande";
  if (counts.pequeno / total >= ratio && counts.pequeno > counts.grande) return "veste_pequeno";
  return null;
}

/** "Veste grande" / "Veste pequeno" (painel). */
export const FIT_SIGNAL_LABELS: Record<FitSignal, string> = {
  veste_grande: "Veste grande",
  veste_pequeno: "Veste pequeno",
};

/** A frase da vitrine, por tamanho: honesta e curta. */
export function fitSignalStoreLine(size: string, signal: FitSignal): string {
  return signal === "veste_grande"
    ? `Pelas clientes, o ${size} tende a vestir grande — na dúvida, um número abaixo.`
    : `Pelas clientes, o ${size} tende a vestir pequeno — na dúvida, um número acima.`;
}
