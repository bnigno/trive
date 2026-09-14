// Ateliê pelo WhatsApp — PURO. O "lote" de uma chegada: as fotos que a dona
// mandou perto do recado (cada foto chega num webhook próprio), no máximo
// INTAKE_MAX_PHOTOS, ainda não usadas por outra chegada. O recado (texto,
// legenda da foto ou áudio transcrito) fecha o lote; a fila espera um
// respiro (INTAKE_GRACE_MS) antes de montá-lo, porque a última foto às
// vezes chega depois do recado.
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";

export const INTAKE_WINDOW_MS = 15 * 60_000;
export const INTAKE_MAX_PHOTOS = 3;
export const INTAKE_GRACE_MS = 45_000;
/** Fotos sem recado há isto: a dona ganha um lembrete ("me conta nome, cores, tamanhos e custo?"). */
export const INTAKE_NUDGE_AFTER_MS = 180_000;
/** Foto que chega até isto depois do recado ainda é da mesma chegada. */
export const INTAKE_LATE_PHOTO_MS = 60_000;

export type IntakeMessage = {
  id: string;
  /** kind de wa_messages: image | audio | text | option_list. */
  kind: string;
  body: string;
  mediaUrl: string | null;
  createdAt: Date;
  /** Já reivindicada por outra chegada. */
  consumed: boolean;
};

export type IntakeBatchOptions = {
  windowMs?: number;
  maxPhotos?: number;
};

export type NoteKind = "text" | "audio" | "caption";

function isPhoto(message: IntakeMessage): boolean {
  return message.kind === "image" && message.mediaUrl !== null && message.mediaUrl !== "";
}

/** Fotos ainda sem recado dentro da janela (o "lote aberto"). */
export function openPhotos(
  messages: readonly IntakeMessage[],
  now: Date,
  options: IntakeBatchOptions = {},
): IntakeMessage[] {
  const windowMs = options.windowMs ?? INTAKE_WINDOW_MS;
  return messages
    .filter((message) => isPhoto(message) && !message.consumed)
    .filter((message) => now.getTime() - message.createdAt.getTime() <= windowMs)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function hasOpenBatch(
  messages: readonly IntakeMessage[],
  now: Date,
  options: IntakeBatchOptions = {},
): boolean {
  return openPhotos(messages, now, options).length > 0;
}

/**
 * A foto que acabou de chegar abre um lote novo? (é a única sem dona na
 * janela) — só ela agenda o lembrete; as seguintes do mesmo lote, não.
 */
export function isBatchStart(
  messages: readonly IntakeMessage[],
  photoId: string,
  now: Date,
  options: IntakeBatchOptions = {},
): boolean {
  const open = openPhotos(messages, now, options);
  return open.length === 1 && open[0].id === photoId;
}

/**
 * Na hora do lembrete: a foto continua sem recado? Reivindicada por uma
 * chegada = o recado chegou. Fora da janela (o lembrete atrasou na fila) a
 * dona ainda é lembrada — o lote só não vale mais para um recado novo.
 */
export function nudgeDue(
  messages: readonly IntakeMessage[],
  photoId: string,
): { due: boolean; photos: number; reason: "recado_chegou" | "foto_sumiu" | null } {
  const photo = messages.find((message) => message.id === photoId);
  if (!photo) return { due: false, photos: 0, reason: "foto_sumiu" };
  if (photo.consumed) return { due: false, photos: 0, reason: "recado_chegou" };
  const since = photo.createdAt.getTime();
  const photos = messages.filter((message) => isPhoto(message) && !message.consumed && message.createdAt.getTime() >= since).length;
  return { due: true, photos, reason: null };
}

/**
 * O recado que a mensagem carrega: a legenda da foto sem o marcador, a
 * transcrição do áudio (vazia quando ainda é só o marcador) ou o texto.
 */
export function noteFromMessage(message: Pick<IntakeMessage, "kind" | "body">): { note: string; noteKind: NoteKind } {
  const body = message.body.trim();
  if (message.kind === "image") {
    const caption = body.startsWith(INBOUND_MEDIA_MARKERS.image)
      ? body.slice(INBOUND_MEDIA_MARKERS.image.length)
      : body;
    return { note: caption.trim(), noteKind: "caption" };
  }
  if (message.kind === "audio") {
    return {
      note: body.startsWith(INBOUND_MEDIA_MARKERS.audio) ? "" : body,
      noteKind: "audio",
    };
  }
  return { note: body, noteKind: "text" };
}

/**
 * As fotos que o recado `trigger` reivindica no ato de abrir a chegada: as
 * não reivindicadas dentro da janela antes dele (a própria foto quando o
 * recado veio como legenda). Passando do máximo, ficam as mais recentes.
 */
export function selectIntakeBatch(
  messages: readonly IntakeMessage[],
  trigger: IntakeMessage,
  options: IntakeBatchOptions = {},
): { photos: IntakeMessage[]; note: string; noteKind: NoteKind } {
  const windowMs = options.windowMs ?? INTAKE_WINDOW_MS;
  const maxPhotos = options.maxPhotos ?? INTAKE_MAX_PHOTOS;
  const at = trigger.createdAt.getTime();

  const candidates = messages.filter(
    (message) =>
      isPhoto(message) &&
      (message.id === trigger.id || !message.consumed) &&
      message.createdAt.getTime() <= at &&
      at - message.createdAt.getTime() <= windowMs,
  );
  const photos = [...candidates]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-maxPhotos);

  return { photos, ...noteFromMessage(trigger) };
}

/**
 * Fotos que chegaram logo DEPOIS do recado (webhooks fora de ordem) e
 * ninguém reivindicou: a montagem, que roda após o respiro, as absorve até
 * completar o máximo.
 */
export function selectLatePhotos(
  messages: readonly IntakeMessage[],
  trigger: IntakeMessage,
  alreadyClaimed: number,
  options: IntakeBatchOptions & { lateMs?: number } = {},
): IntakeMessage[] {
  const maxPhotos = options.maxPhotos ?? INTAKE_MAX_PHOTOS;
  const lateMs = options.lateMs ?? INTAKE_LATE_PHOTO_MS;
  const at = trigger.createdAt.getTime();
  const room = Math.max(0, maxPhotos - alreadyClaimed);
  if (room === 0) return [];
  return messages
    .filter(
      (message) =>
        isPhoto(message) &&
        !message.consumed &&
        message.id !== trigger.id &&
        message.createdAt.getTime() > at &&
        message.createdAt.getTime() - at <= lateMs,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, room);
}
