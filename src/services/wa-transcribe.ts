// A vendedora "ouve": o áudio da cliente é baixado da Z-API, transcrito pelo
// adapter e gravado como o texto da própria mensagem (o painel e o modelo
// leem a transcrição). Só então a mensagem é roteada — turno da vendedora ou
// encaminhamento ao dono — na MESMA transação da gravação, com os dedupes de
// sempre. Falha do vendor relança (retry da fila) até a última tentativa,
// quando o marcador "não foi possível transcrever" entra e a conversa segue.
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  TranscriptionUnavailableError,
  type Transcriber,
} from "@/adapters/transcription";
import type { MessagingProvider } from "@/adapters/zapi";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import {
  INBOUND_MEDIA_MARKERS,
  MAX_AUDIO_SECONDS,
  parseWaMediaMeta,
} from "@/core/whatsapp/media";
import { auditLog, customers, waConversations, waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { routeInboundMessage } from "@/services/wa-inbound";

export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const TRANSCRIPT_MAX_CHARS = 4000;
const FORWARD_QUOTE_MAX_CHARS = 280;

export type TranscribeInboundAudioResult =
  | { transcribed: true; route: "bot_queued" | "forwarded"; chars: number; durationMs: number }
  | { fallback: "falhou" | "longo" | "vazio"; route: "bot_queued" | "forwarded" }
  | { skipped: "ja_processado" | "mensagem_inexistente" | "sem_url" };

const inputSchema = z.object({
  waMessageId: z.uuid(),
  /** Tentativas já esgotadas antes desta (0 na primeira; como o worker conta). */
  attempt: z.number().int().min(0),
});

function isLastAttempt(attempt: number): boolean {
  return attempt + 1 >= getRetryPolicy("wa.transcribe").maxAttempts;
}

export async function transcribeInboundAudio(
  db: DbOrTx,
  provider: MessagingProvider,
  transcriber: Transcriber,
  input: z.input<typeof inputSchema>,
): Promise<TranscribeInboundAudioResult> {
  const { waMessageId, attempt } = inputSchema.parse(input);

  const [row] = await db
    .select({
      id: waMessages.id,
      kind: waMessages.kind,
      zapiMessageId: waMessages.zapiMessageId,
      mediaUrl: waMessages.mediaUrl,
      mediaMeta: waMessages.mediaMeta,
      conversationId: waConversations.id,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      phoneE164: waConversations.phoneE164,
      customerName: customers.fullName,
    })
    .from(waMessages)
    .innerJoin(waConversations, eq(waConversations.id, waMessages.conversationId))
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(waMessages.id, waMessageId))
    .limit(1);
  if (!row) return { skipped: "mensagem_inexistente" };
  if (row.kind !== "audio" || !row.mediaUrl || !row.zapiMessageId) return { skipped: "sem_url" };

  const meta = parseWaMediaMeta(row.mediaMeta);
  if (meta.transcript && meta.transcript.status !== "pending") {
    return { skipped: "ja_processado" };
  }

  const startedAt = Date.now();
  let outcome:
    | { kind: "done"; text: string; model: string }
    | { kind: "fallback"; reason: "falhou" | "longo" | "vazio" };

  if (meta.seconds !== undefined && meta.seconds > MAX_AUDIO_SECONDS) {
    outcome = { kind: "fallback", reason: "longo" };
  } else {
    try {
      const media = await provider.downloadMedia({ url: row.mediaUrl, maxBytes: AUDIO_MAX_BYTES });
      const transcription = await transcriber.transcribe({
        data: media.data,
        mimeType: meta.mimeType ?? media.contentType ?? "audio/ogg",
        languageHint: "pt",
      });
      const text = transcription.text.replace(/\s+/g, " ").trim().slice(0, TRANSCRIPT_MAX_CHARS);
      outcome =
        text.replace(/[^\p{L}\p{N}]/gu, "") === ""
          ? { kind: "fallback", reason: "vazio" }
          : { kind: "done", text, model: transcription.model };
    } catch (error) {
      // Vendor/rede: deixa a fila tentar de novo; na última, cai no marcador.
      if (!isLastAttempt(attempt)) throw error;
      const reason = error instanceof TranscriptionUnavailableError ? error.message : "download";
      console.warn(`[wa-transcribe] ${waMessageId} sem transcrição após ${attempt + 1} tentativas: ${reason}`);
      outcome = { kind: "fallback", reason: "falhou" };
    }
  }

  const durationMs = Date.now() - startedAt;
  const body =
    outcome.kind === "done"
      ? outcome.text
      : outcome.reason === "longo"
        ? `${INBOUND_MEDIA_MARKERS.audio} (áudio longo demais para transcrever)`
        : `${INBOUND_MEDIA_MARKERS.audio} (não foi possível transcrever)`;
  const transcript =
    outcome.kind === "done"
      ? { status: "done" as const, ms: durationMs, model: outcome.model, chars: outcome.text.length }
      : { status: (outcome.reason === "longo" ? "skipped" : "failed") as "skipped" | "failed", ms: durationMs, reason: outcome.reason };

  return db.transaction(async (tx) => {
    await tx
      .update(waMessages)
      .set({ body, mediaMeta: { ...meta, transcript } })
      .where(eq(waMessages.id, row.id));

    const route = await routeInboundMessage(tx, {
      conversation: { id: row.conversationId, status: row.status, botDisabledUntil: row.botDisabledUntil },
      phoneE164: row.phoneE164,
      zapiMessageId: row.zapiMessageId as string,
      text: body,
      forwardText:
        outcome.kind === "done"
          ? `🎤 (áudio) "${outcome.text.slice(0, FORWARD_QUOTE_MAX_CHARS)}"`
          : `🎤 (áudio) ${body}`,
      ...(row.customerName ? { customerName: row.customerName } : {}),
      now: new Date(),
    });

    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.transcribe",
      entityType: "wa_message",
      entityId: row.id,
      after: {
        status: transcript.status,
        seconds: meta.seconds ?? null,
        ms: durationMs,
        chars: outcome.kind === "done" ? outcome.text.length : 0,
        model: outcome.kind === "done" ? outcome.model : null,
        route,
      },
    });

    return outcome.kind === "done"
      ? { transcribed: true, route, chars: outcome.text.length, durationMs }
      : { fallback: outcome.reason, route };
  });
}
