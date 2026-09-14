// A nota da curadora na peça: grava o áudio, transcreve e guarda o texto
// para a dona corrigir. A transcrição é leitura ao vendor (sem efeito
// externo visível), então acontece ANTES da transação — o mesmo padrão do
// upload de foto. Vendor fora do ar não impede: o áudio fica salvo e a tela
// pede para digitar.

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import {
  TranscriptionUnavailableError,
  type Transcriber,
  type TranscriptionFailureReason,
} from "@/adapters/transcription";
import {
  CURATOR_AUDIO_MAX_BYTES,
  CURATOR_AUDIO_MAX_SECONDS,
  CURATOR_NOTE_MAX_CHARS,
  curatorAudioFormat,
  curatorAudioStoragePath,
  fitCuratorNote,
} from "@/core/catalog/curator-note";
import { auditLog, products, settings } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
// A mesma classe de erro do catálogo: é a que a tela da peça reconhece.
import { ServiceError } from "@/services/catalog";

/** Setting bot_audio_notes_enabled: ausente = ligado (a Lia manda a voz da curadora). */
export async function isBotAudioNotesEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "bot_audio_notes_enabled")).limit(1);
  return row?.value !== false;
}

/**
 * Por que o texto (não) veio: "ok" transcreveu; "empty" o áudio não tinha
 * fala; os demais são do vendor (sem chave, recusou este áudio, cota, fora
 * do ar). A tela escolhe a frase por aqui.
 */
export type CuratorNoteOutcome = "ok" | "empty" | TranscriptionFailureReason;

export type CuratorNoteResult = {
  note: string | null;
  audioPath: string;
  transcribed: boolean;
  /** A fala passou do teto de caracteres e o fim foi cortado. */
  truncated: boolean;
  reason: CuratorNoteOutcome;
  /** O texto devolvido é o de antes (a gravação nova não rendeu texto). */
  staleNote: boolean;
};

const recordSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
  audio: z.object({
    data: z.instanceof(Buffer),
    contentType: z.string().min(1),
    /** O que o navegador disse antes de a action resolver o formato (só para o audit). */
    originalContentType: z.string().optional(),
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

/** Apaga um áudio do bucket sem deixar a operação principal falhar por isso. */
async function removeAudioBestEffort(storage: FileStorage, path: string, why: string): Promise<void> {
  try {
    await storage.remove(path);
  } catch (error) {
    console.warn(`[curator-note] áudio não removido do storage (${why}): ${path}`, error);
  }
}

/** Grava a nota falada: sobe o áudio, transcreve e guarda o texto para revisão. */
export async function recordCuratorNote(
  db: DbOrTx,
  storage: FileStorage,
  transcriber: Transcriber,
  input: z.input<typeof recordSchema>,
): Promise<CuratorNoteResult> {
  const parsed = recordSchema.parse(input);
  const format = curatorAudioFormat(parsed.audio.contentType);
  if (!format) {
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
  const path = curatorAudioStoragePath(parsed.productId, randomUUID(), format.extension);
  // O mime canônico, sem parâmetros: o bucket compara por igualdade e a
  // coluna é o contrato de quem vai tocar o áudio depois (vitrine, Lia).
  try {
    await storage.upload({ path, data: parsed.audio.data, contentType: format.mime });
  } catch (error) {
    console.error(`[curator-note] upload recusado (${format.mime}, ${path})`, error);
    throw new ServiceError(
      "audio_nao_guardado",
      "Não consegui guardar o áudio agora. Se continuar, avise quem cuida do sistema: o repositório de arquivos pode não estar aceitando áudio.",
    );
  }

  try {
    let note = product.curatorNote;
    let transcribed = false;
    let truncated = false;
    let reason: CuratorNoteOutcome = "empty";
    let model: string | null = null;
    try {
      const transcription = await transcriber.transcribe({
        data: parsed.audio.data,
        mimeType: format.mime,
        languageHint: "pt",
      });
      model = transcription.model;
      const fitted = fitCuratorNote(transcription.text);
      if (fitted.text) {
        note = fitted.text;
        transcribed = true;
        truncated = fitted.truncated;
        reason = "ok";
      }
    } catch (error) {
      // Vendor fora do ar não perde a gravação: o áudio já está salvo e a dona
      // escreve a nota à mão (ou reenvia quando ele voltar).
      if (!(error instanceof TranscriptionUnavailableError)) throw error;
      reason = error.reason;
      console.warn(`[curator-note] ${parsed.productId} sem transcrição (${error.reason}): ${error.message}`);
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({
          curatorAudioPath: path,
          curatorAudioMime: format.mime,
          curatorAudioSeconds: parsed.audio.seconds ?? null,
          updatedAt: now,
          // O texto (e o seu carimbo) só mudam quando a transcrição rendeu
          // texto: a tela remonta o campo pelo carimbo, e um rascunho digitado
          // não pode sumir por causa de um áudio que não transcreveu.
          ...(transcribed ? { curatorNote: note, curatorNoteUpdatedAt: now } : {}),
        })
        .where(eq(products.id, parsed.productId));
      await tx.insert(auditLog).values({
        actorType: "user",
        actorId: parsed.userId,
        action: "product.curator_note_recorded",
        entityType: "product",
        entityId: parsed.productId,
        // O texto inteiro (é curto): é daqui que se recupera uma nota
        // corrigida à mão que a regravação sobrescreveu.
        before: { note: product.curatorNote, audioPath: product.curatorAudioPath },
        after: {
          note,
          audioPath: path,
          mime: format.mime,
          originalMime: parsed.audio.originalContentType ?? parsed.audio.contentType,
          seconds: parsed.audio.seconds ?? null,
          transcribed,
          truncated,
          reason,
          model,
        },
      });
    });

    // O áudio anterior sai do bucket em melhor esforço: falhar aqui não desfaz
    // a nota nova.
    if (product.curatorAudioPath && product.curatorAudioPath !== path) {
      await removeAudioBestEffort(storage, product.curatorAudioPath, "áudio anterior");
    }

    return { note, audioPath: path, transcribed, truncated, reason, staleNote: !transcribed && note !== null };
  } catch (error) {
    // Nada foi gravado no banco: o arquivo que subiu não pode ficar órfão e
    // público. Erro inesperado (bug, banco) fica no log do servidor.
    if (!(error instanceof ServiceError)) {
      console.error(`[curator-note] ${parsed.productId} falha depois do upload (${path})`, error);
    }
    await removeAudioBestEffort(storage, path, "falha depois do upload");
    throw error;
  }
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
  const fitted = fitCuratorNote(parsed.note);
  if (fitted.text === null && parsed.note.trim() !== "") {
    // Só símbolos ou emoji: não é uma nota, mas também não é "apagar".
    throw new ServiceError(
      "nota_sem_texto",
      "Escreva ao menos uma palavra na nota — ou deixe o campo vazio para apagá-la.",
    );
  }
  if (fitted.truncated) {
    // A tela já limita; aqui é a rede final — cortar em silêncio o que a
    // dona escreveu seria pior do que recusar.
    throw new ServiceError(
      "nota_longa",
      `A nota vai até ${CURATOR_NOTE_MAX_CHARS} caracteres. Encurte um pouco e salve de novo.`,
    );
  }
  const note = fitted.text;
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
      before: { note: product.curatorNote },
      after: { note },
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
  await removeAudioBestEffort(storage, product.curatorAudioPath, "remover áudio");
  return { removed: true };
}
