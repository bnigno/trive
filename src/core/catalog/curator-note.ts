// A nota da curadora: a dona grava a voz dela sobre a peça, o texto vem da
// transcrição e ela corrige. PURO — limites, formatos aceitos, limpeza do
// texto e o caminho do arquivo no Storage.

/** Um minuto é o que cabe numa nota falada sem virar áudio de WhatsApp. */
export const CURATOR_AUDIO_MAX_SECONDS = 60;
/** 3 MB cobre 60 s em opus/aac com folga (e cabe na server action). */
export const CURATOR_AUDIO_MAX_BYTES = 3 * 1024 * 1024;
/** Um minuto de fala em português dá ~900 caracteres: 1000 cabe sem cortar. */
export const CURATOR_NOTE_MAX_CHARS = 1000;

export type CuratorAudioFormat = {
  /** O mime que vai para o bucket, a coluna e o transcritor — sem parâmetros nem apelidos. */
  mime: "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/mpeg";
  extension: "webm" | "ogg" | "m4a" | "mp3";
};

const FORMAT_BY_MIME: Record<string, CuratorAudioFormat> = {
  "audio/webm": { mime: "audio/webm", extension: "webm" },
  "audio/ogg": { mime: "audio/ogg", extension: "ogg" },
  "audio/opus": { mime: "audio/ogg", extension: "ogg" },
  "audio/mp4": { mime: "audio/mp4", extension: "m4a" },
  "audio/x-m4a": { mime: "audio/mp4", extension: "m4a" },
  "audio/m4a": { mime: "audio/mp4", extension: "m4a" },
  "audio/aac": { mime: "audio/mp4", extension: "m4a" },
  "audio/mpeg": { mime: "audio/mpeg", extension: "mp3" },
  "audio/mp3": { mime: "audio/mpeg", extension: "mp3" },
};

const FORMAT_BY_EXTENSION: Record<string, CuratorAudioFormat> = {
  webm: FORMAT_BY_MIME["audio/webm"],
  ogg: FORMAT_BY_MIME["audio/ogg"],
  oga: FORMAT_BY_MIME["audio/ogg"],
  opus: FORMAT_BY_MIME["audio/ogg"],
  m4a: FORMAT_BY_MIME["audio/mp4"],
  mp4: FORMAT_BY_MIME["audio/mp4"],
  aac: FORMAT_BY_MIME["audio/mp4"],
  mp3: FORMAT_BY_MIME["audio/mpeg"],
};

/**
 * Os mimes que o bucket precisa aceitar (o Supabase compara por igualdade,
 * sem parâmetros): é esta lista que scripts/setup-storage.ts manda.
 */
export const CURATOR_AUDIO_CANONICAL_MIMES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
] as const;

/**
 * O formato canônico para o que o navegador entregou: "audio/webm;codecs=opus"
 * (Chrome) vira webm, "audio/mp4" (iPhone) vira m4a, apelidos como
 * "audio/x-m4a" e "audio/mp3" entram no formato certo. Mime que não é áudio
 * conhecido devolve null: o serviço recusa.
 */
export function curatorAudioFormat(mime: string): CuratorAudioFormat | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return FORMAT_BY_MIME[base] ?? null;
}

/** Só a extensão (compatibilidade com quem só precisa dela). */
export function curatorAudioExtension(mime: string): string | null {
  return curatorAudioFormat(mime)?.extension ?? null;
}

/**
 * O formato de um arquivo escolhido do aparelho: pelo mime que o navegador
 * disse ou, quando ele não diz nada útil (acontece no Android com m4a, que
 * chega como application/octet-stream), pela extensão do nome.
 */
export function resolveCuratorAudioFormat(type: string, fileName: string): CuratorAudioFormat | null {
  const byMime = curatorAudioFormat(type);
  if (byMime) return byMime;
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

/** Tem alguma letra ou número: silêncio e ruído viram só pontuação na transcrição. */
export function hasSpokenContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Texto da nota como fica salvo: sem espaço sobrando, uma linha só por
 * parágrafo, no teto de caracteres — cortado na última palavra inteira, com
 * reticências, e `truncated` avisando que faltou fala. Vazio, ou só
 * pontuação, vira null (a peça fica sem nota).
 */
export function fitCuratorNote(text: string | null | undefined): { text: string | null; truncated: boolean } {
  const clean = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
  if (clean === "" || !hasSpokenContent(clean)) return { text: null, truncated: false };
  // Por pontos de código: um emoji não pode ficar pela metade.
  const chars = Array.from(clean);
  if (chars.length <= CURATOR_NOTE_MAX_CHARS) return { text: clean, truncated: false };
  const room = chars.slice(0, CURATOR_NOTE_MAX_CHARS - 1).join("");
  const lastBreak = Math.max(room.lastIndexOf(" "), room.lastIndexOf("\n"));
  // Volta até a última palavra quando sobra texto de verdade; um parágrafo
  // sem espaços (não é fala) corta onde dá.
  const cut = lastBreak > CURATOR_NOTE_MAX_CHARS / 2 ? room.slice(0, lastBreak) : room;
  return { text: `${cut.trimEnd().replace(/[,;:.!?…-]+$/, "")}…`, truncated: true };
}

/** O texto normalizado, sem o aviso de corte (quem só precisa do texto). */
export function normalizeCuratorNote(text: string | null | undefined): string | null {
  return fitCuratorNote(text).text;
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
