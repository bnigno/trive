// Mídia recebida da cliente pelo WhatsApp — PURO. O marcador que a mensagem
// assume no painel e no histórico do modelo, os metadados (jsonb) e a regra
// de "áudio ainda sendo transcrito".
import { z } from "zod";

export const INBOUND_MEDIA_MARKERS = {
  image: "[a cliente enviou uma foto]",
  audio: "[a cliente enviou um áudio]",
  video: "[a cliente enviou um vídeo]",
  document: "[a cliente enviou um documento]",
  sticker: "[a cliente enviou uma figurinha]",
  location: "[a cliente enviou uma localização]",
} as const;

export const MAX_AUDIO_SECONDS = 300;
/** Depois disso, um áudio sem transcrição entra como marcador e o turno segue. */
export const AUDIO_PENDING_GRACE_MS = 120_000;

export const waMediaMetaSchema = z
  .object({
    mimeType: z.string().optional(),
    seconds: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    transcript: z
      .object({
        status: z.enum(["pending", "done", "failed", "skipped"]),
        ms: z.number().optional(),
        model: z.string().optional(),
        chars: z.number().optional(),
        reason: z.string().optional(),
      })
      .optional(),
    /** Impressão digital da foto (16 hex, core/images/phash.ts) — a foto em si nunca é guardada. */
    phash: z.string().optional(),
    /** O que a Lia reconheceu nesta foto (identificar_peca_na_foto). */
    reconhecido: z
      .object({
        slugs: z.array(z.string()),
        nomes: z.array(z.string()),
        camada: z.enum(["hash", "visao"]),
        /** exato = a mesma foto; provavel = visão ≥ 0,75; talvez = a Lia ainda precisa confirmar com a cliente. */
        nivel: z.enum(["exato", "provavel", "talvez"]).optional(),
        distancia: z.number().optional(),
        confianca: z.number().optional(),
      })
      .optional(),
  })
  .loose();

export type WaMediaMeta = z.infer<typeof waMediaMetaSchema>;

/** Tolerante: jsonb torto ou nulo vira {} em vez de derrubar o turno. */
export function parseWaMediaMeta(raw: unknown): WaMediaMeta {
  const parsed = waMediaMetaSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Áudio enfileirado para transcrição há pouco e ainda sem resultado. */
export function isAudioAwaitingTranscription(
  meta: WaMediaMeta,
  createdAt: Date,
  now: Date,
): boolean {
  if (meta.transcript?.status !== "pending") return false;
  return now.getTime() - createdAt.getTime() < AUDIO_PENDING_GRACE_MS;
}

/** O que aconteceu com a foto deste turno a caminho do modelo. */
export type ImageAttachState = "attached" | "unavailable" | "old";

/**
 * Texto que uma mensagem RECEBIDA assume no histórico do modelo. A foto do
 * turno vai anexada como imagem; a que não abriu (URL expirada, recurso
 * desligado) pede para a cliente descrever; a antiga vira só o marcador,
 * com a instrução de não inventar o que havia nela.
 */
export function historyTextForInbound(input: {
  kind: string;
  body: string;
  mediaMeta: WaMediaMeta;
  image?: ImageAttachState;
}): string {
  if (input.kind === "audio") {
    if (input.mediaMeta.transcript?.status === "done") {
      return `[áudio da cliente, transcrição automática] ${input.body}`;
    }
    return `${INBOUND_MEDIA_MARKERS.audio} (não foi possível transcrever)`;
  }
  if (input.kind === "image") {
    switch (input.image) {
      case "attached":
        return `${input.body} (a foto está anexada nesta mensagem)`;
      case "unavailable":
        return `${input.body} (não foi possível abrir a foto — peça para ela descrever a peça ou reenviar)`;
      default:
        return `${input.body} (foto antiga, não anexada — não descreva o que havia nela)`;
    }
  }
  return input.body;
}
