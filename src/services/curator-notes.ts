// A nota da curadora na peça: grava o áudio, transcreve e guarda o texto
// para a dona corrigir. A transcrição é leitura ao vendor (sem efeito
// externo visível), então acontece ANTES da transação — o mesmo padrão do
// upload de foto. Vendor fora do ar não impede: o áudio fica salvo e a tela
// pede para digitar.

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import { TranscriptionUnavailableError, type Transcriber } from "@/adapters/transcription";
import {
  CURATOR_AUDIO_MAX_BYTES,
  CURATOR_AUDIO_MAX_SECONDS,
  curatorAudioExtension,
  curatorAudioStoragePath,
  normalizeCuratorNote,
} from "@/core/catalog/curator-note";
import { auditLog, products } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";

export type CuratorNoteResult = {
  note: string | null;
  audioPath: string;
  transcribed: boolean;
};

const recordSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
  audio: z.object({
    data: z.instanceof(Buffer),
    contentType: z.string().min(1),
    seconds: z.number().int().min(1).max(600).optional(),
  }),
});

async function requireProductRow(db: DbOrTx, productId: string) {
  const [product] = await db
    .select({
      id: products.id,
      curatorNote: products.curatorNote,
      curatorAudioPath: products.curatorAudioPath,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new ServiceError("nao_encontrado", "Peça não encontrada.");
  return product;
}

/** Grava a nota falada: sobe o áudio, transcreve e guarda o texto para revisão. */
export async function recordCuratorNote(
  db: DbOrTx,
  storage: FileStorage,
  transcriber: Transcriber,
  input: z.input<typeof recordSchema>,
): Promise<CuratorNoteResult> {
  const parsed = recordSchema.parse(input);
  const extension = curatorAudioExtension(parsed.audio.contentType);
  if (!extension) {
    throw new ServiceError(
      "audio_invalido",
      "Não reconheci esse formato de áudio. Grave pelo botão da tela ou envie um arquivo comum (m4a, mp3, ogg).",
    );
  }
  if (parsed.audio.data.byteLength > CURATOR_AUDIO_MAX_BYTES) {
    throw new ServiceError(
      "audio_grande",
      "O áudio ficou grande demais. Grave uma nota mais curta (até um minuto).",
    );
  }
  if (parsed.audio.seconds !== undefined && parsed.audio.seconds > CURATOR_AUDIO_MAX_SECONDS) {
    throw new ServiceError(
      "audio_longo",
      `A nota da curadora vai até ${CURATOR_AUDIO_MAX_SECONDS} segundos. Grave de novo, mais curtinha.`,
    );
  }

  const product = await requireProductRow(db, parsed.productId);
  const path = curatorAudioStoragePath(parsed.productId, randomUUID(), extension);
  await storage.upload({ path, data: parsed.audio.data, contentType: parsed.audio.contentType });

  let note = product.curatorNote;
  let transcribed = false;
  let model: string | null = null;
  try {
    const transcription = await transcriber.transcribe({
      data: parsed.audio.data,
      mimeType: parsed.audio.contentType,
      languageHint: "pt",
    });
    const text = normalizeCuratorNote(transcription.text);
    if (text) {
      note = text;
      transcribed = true;
      model = transcription.model;
    }
  } catch (error) {
    // Vendor fora do ar não perde a gravação: o áudio já está salvo e a dona
    // escreve a nota à mão.
    if (!(error instanceof TranscriptionUnavailableError)) throw error;
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        curatorNote: note,
        curatorAudioPath: path,
        curatorAudioMime: parsed.audio.contentType,
        curatorAudioSeconds: parsed.audio.seconds ?? null,
        curatorNoteUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(products.id, parsed.productId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "product.curator_note_recorded",
      entityType: "product",
      entityId: parsed.productId,
      before: { audioPath: product.curatorAudioPath, chars: product.curatorNote?.length ?? 0 },
      after: {
        audioPath: path,
        seconds: parsed.audio.seconds ?? null,
        chars: note?.length ?? 0,
        transcribed,
        model,
      },
    });
  });

  // O áudio anterior sai do bucket em melhor esforço: falhar aqui não desfaz
  // a nota nova.
  if (product.curatorAudioPath && product.curatorAudioPath !== path) {
    await storage.remove(product.curatorAudioPath).catch(() => undefined);
  }

  return { note, audioPath: path, transcribed };
}

const updateSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
  note: z.string(),
});

/** A dona corrige o texto da nota (a transcrição erra uma palavra ou outra). */
export async function updateCuratorNote(
  db: DbOrTx,
  input: z.input<typeof updateSchema>,
): Promise<{ note: string | null }> {
  const parsed = updateSchema.parse(input);
  const product = await requireProductRow(db, parsed.productId);
  const note = normalizeCuratorNote(parsed.note);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({ curatorNote: note, curatorNoteUpdatedAt: now, updatedAt: now })
      .where(eq(products.id, parsed.productId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "product.curator_note_updated",
      entityType: "product",
      entityId: parsed.productId,
      before: { chars: product.curatorNote?.length ?? 0 },
      after: { chars: note?.length ?? 0 },
    });
  });
  return { note };
}

/** Tira só o áudio: o texto da nota continua na peça. */
export async function removeCuratorAudio(
  db: DbOrTx,
  storage: FileStorage,
  input: { productId: string; userId: string },
): Promise<{ removed: boolean }> {
  const productId = z.uuid().parse(input.productId);
  const userId = z.uuid().parse(input.userId);
  const product = await requireProductRow(db, productId);
  if (!product.curatorAudioPath) return { removed: false };

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        curatorAudioPath: null,
        curatorAudioMime: null,
        curatorAudioSeconds: null,
        curatorNoteUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(products.id, productId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "product.curator_audio_removed",
      entityType: "product",
      entityId: productId,
      before: { audioPath: product.curatorAudioPath },
      after: { audioPath: null },
    });
  });
  await storage.remove(product.curatorAudioPath).catch(() => undefined);
  return { removed: true };
}
