// A nota da curadora: a dona grava a voz dela sobre a peça, o texto vem da
// transcrição e ela corrige. PURO — limites, formatos aceitos, limpeza do
// texto e o caminho do arquivo no Storage.

/** Um minuto é o que cabe numa nota falada sem virar áudio de WhatsApp. */
export const CURATOR_AUDIO_MAX_SECONDS = 60;
/** 3 MB cobre 60 s em opus/aac com folga (e cabe na server action). */
export const CURATOR_AUDIO_MAX_BYTES = 3 * 1024 * 1024;
export const CURATOR_NOTE_MAX_CHARS = 700;

const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
};

/**
 * Extensão do arquivo para o mime que o gravador entregou. O navegador manda
 * "audio/webm;codecs=opus" e o iPhone manda "audio/mp4" — os dois valem.
 * Mime que não é áudio conhecido devolve null: o serviço recusa.
 */
export function curatorAudioExtension(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_MIME[base] ?? null;
}

/**
 * Texto da nota como fica salvo: sem espaço sobrando, uma linha só por
 * parágrafo, no teto de caracteres. Vazio vira null (a peça fica sem nota).
 */
export function normalizeCuratorNote(text: string | null | undefined): string | null {
  const clean = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
  if (clean === "") return null;
  return clean.length > CURATOR_NOTE_MAX_CHARS
    ? `${clean.slice(0, CURATOR_NOTE_MAX_CHARS - 1).trimEnd()}…`
    : clean;
}

/** products/<id>/nota-curadora-<token>.<ext> — token novo a cada gravação. */
export function curatorAudioStoragePath(
  productId: string,
  token: string,
  extension: string,
): string {
  return `products/${productId}/nota-curadora-${token}.${extension}`;
}

/** Segundos exibidos: "0:47". */
export function formatAudioSeconds(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}
