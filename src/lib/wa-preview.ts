/** Prévia curta de uma mensagem para toast, aviso de sistema e push: uma linha, sem quebra, no máximo 120 caracteres. */
export function inboundPreview(body: string | null | undefined): string | null {
  const oneLine = (body ?? "").replace(/\s+/g, " ").trim();
  if (oneLine === "") return null;
  return oneLine.length > 120 ? `${oneLine.slice(0, 119).trimEnd()}…` : oneLine;
}
