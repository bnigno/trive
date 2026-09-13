// Ateliê pelo WhatsApp: a dona manda fotos e um recado do celular DELA para
// o número da maison e a peça nasce em rascunho, com as fotos publicadas
// (full/md/thumb), nada na loja. Duas metades: a decisão no webhook (é a
// dona? é foto, recado ou pedido de ajuda?) e a montagem do rascunho na
// fila (baixa as fotos, cria o produto, responde "Rascunho pronto").
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  INTAKE_GRACE_MS,
  INTAKE_WINDOW_MS,
  hasOpenBatch,
  noteFromMessage,
  selectIntakeBatch,
  type IntakeMessage,
  type NoteKind,
} from "@/core/atelier/batch";
import { draftNameFromNote } from "@/core/atelier/name";
import {
  atelierDraftVars,
  atelierHelpReasonText,
  isAtelierHelpReason,
  type AtelierHelpReason,
} from "@/core/atelier/reply";
import { buildSku, dedupeSkus, skuBaseFromName } from "@/core/catalog/sku";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import {
  atelierIntakes,
  auditLog,
  productImages,
  productVariants,
  settings,
  users,
  waMessages,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { addProductImage, createProduct, type ServiceDb } from "@/services/catalog";
import { isBotMediaEnabled } from "@/services/wa-media";
import { sendToOwner, siteBaseUrl, type SendWaMessageResult } from "@/services/wa-messaging";

/** Foto original da câmera (a ficha reduz depois); acima disso a foto fica de fora. */
export const ATELIER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
export const ATELIER_DRAFT_TEMPLATE = "owner_atelier_draft";
export const ATELIER_HELP_TEMPLATE = "owner_atelier_help";

/** Setting atelier_enabled: ausente = ligado. */
export async function isAtelierEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "atelier_enabled"))
    .limit(1);
  return row?.value !== false;
}

/** Quem assina o rascunho no audit: o primeiro dono ativo do painel. */
export async function resolveAtelierActorUserId(db: DbOrTx): Promise<string | null> {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "owner"), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return owner?.id ?? null;
}

/**
 * As mensagens recebidas da dona num período, com a marca "já usada": uma
 * foto pertence à chegada cujo recado veio depois dela (o recado fecha o
 * lote). A chegada `excludeIntakeId` não conta — é a que está sendo montada.
 */
async function loadIntakeMessages(
  db: DbOrTx,
  input: { conversationId: string; from: Date; to: Date; excludeIntakeId?: string },
): Promise<IntakeMessage[]> {
  const rows = await db
    .select({
      id: waMessages.id,
      kind: waMessages.kind,
      body: waMessages.body,
      mediaUrl: waMessages.mediaUrl,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.conversationId, input.conversationId),
        eq(waMessages.direction, "inbound"),
        gte(waMessages.createdAt, input.from),
        lte(waMessages.createdAt, input.to),
      ),
    )
    .orderBy(asc(waMessages.createdAt));

  const intakes = await db
    .select({ id: atelierIntakes.id, createdAt: atelierIntakes.createdAt })
    .from(atelierIntakes)
    .where(
      and(
        eq(atelierIntakes.conversationId, input.conversationId),
        gte(atelierIntakes.createdAt, input.from),
        ne(atelierIntakes.status, "failed"),
      ),
    );
  const closers = intakes
    .filter((intake) => intake.id !== input.excludeIntakeId)
    .map((intake) => intake.createdAt.getTime());

  return rows.map((row) => ({
    ...row,
    consumed: closers.some((closedAt) => closedAt >= row.createdAt.getTime()),
  }));
}

export async function hasOpenAtelierBatch(db: DbOrTx, conversationId: string, now: Date): Promise<boolean> {
  const messages = await loadIntakeMessages(db, {
    conversationId,
    from: new Date(now.getTime() - INTAKE_WINDOW_MS),
    to: new Date(now.getTime() + 60_000),
  });
  return hasOpenBatch(messages, now);
}

// ---------------------------------------------------------------------------
// A decisão no webhook: mensagem da dona no número da maison.
// ---------------------------------------------------------------------------

export type OwnerInboundRoute =
  | { kind: "intake" }
  | { kind: "photo" }
  | { kind: "transcribe" }
  | { kind: "help"; reason: AtelierHelpReason }
  | { kind: "normal" };

/**
 * Foto → abre/estende o lote (com legenda, já é o recado). Áudio → vai
 * transcrever e volta aqui como `note`. Recado (texto ou transcrição) com
 * fotos recentes → chegada. Texto solto → fluxo normal: a dona pode testar
 * a Lia como cliente. Documento → orientação (a Z-API não entrega a foto).
 */
export async function routeOwnerInbound(
  db: DbOrTx,
  input: {
    conversationId: string;
    kind: "image" | "audio" | "text" | "note";
    body: string;
    mediaUrl: string | null;
    now: Date;
  },
): Promise<OwnerInboundRoute> {
  if (input.kind === "image") {
    if (!input.mediaUrl) return { kind: "help", reason: "fotos_indisponiveis" };
    return noteFromMessage({ kind: "image", body: input.body }).note ? { kind: "intake" } : { kind: "photo" };
  }
  if (input.kind === "audio") {
    if (input.mediaUrl && (await isBotMediaEnabled(db)) && isTranscriptionConfigured()) {
      return { kind: "transcribe" };
    }
    return { kind: "help", reason: "audio_sem_transcricao" };
  }
  if (input.body.startsWith(INBOUND_MEDIA_MARKERS.document)) {
    return { kind: "help", reason: "documento" };
  }
  if (
    input.body.startsWith(INBOUND_MEDIA_MARKERS.video) ||
    input.body.startsWith(INBOUND_MEDIA_MARKERS.sticker) ||
    input.body.startsWith(INBOUND_MEDIA_MARKERS.location)
  ) {
    return { kind: "normal" };
  }
  if (await hasOpenAtelierBatch(db, input.conversationId, input.now)) return { kind: "intake" };
  return input.kind === "note" ? { kind: "help", reason: "sem_fotos" } : { kind: "normal" };
}

/**
 * Abre a chegada na MESMA transação do webhook (o recado é o gatilho; a
 * reentrega da Z-API bate no UNIQUE e não duplica) e agenda a montagem
 * para depois do respiro — a última foto às vezes chega depois do recado.
 */
export async function openAtelierIntake(
  tx: DbOrTx,
  input: {
    conversationId: string;
    triggerWaMessageId: string;
    zapiMessageId: string;
    kind: string;
    body: string;
    now: Date;
  },
): Promise<string | null> {
  const { note, noteKind } = noteFromMessage({ kind: input.kind, body: input.body });
  const [intake] = await tx
    .insert(atelierIntakes)
    .values({
      conversationId: input.conversationId,
      triggerWaMessageId: input.triggerWaMessageId,
      note,
      noteKind,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: atelierIntakes.triggerWaMessageId })
    .returning({ id: atelierIntakes.id });
  if (!intake) return null;
  await enqueueOutboxEvent(tx, {
    eventType: "wa.atelier_intake",
    dedupeKey: `wa.atelier:${input.zapiMessageId}`,
    aggregateType: "wa_conversation",
    aggregateId: input.conversationId,
    payload: { conversationId: input.conversationId, triggerWaMessageId: input.triggerWaMessageId },
    nextAttemptAt: new Date(input.now.getTime() + INTAKE_GRACE_MS),
  });
  return intake.id;
}

export async function enqueueAtelierHelp(
  tx: DbOrTx,
  input: { conversationId: string; zapiMessageId: string; reason: AtelierHelpReason },
): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: "wa.atelier_help",
    dedupeKey: `wa.atelier_help:${input.zapiMessageId}`,
    aggregateType: "wa_conversation",
    aggregateId: input.conversationId,
    payload: { reason: input.reason, dedupeKey: `wa.atelier_help:${input.zapiMessageId}` },
  });
}

export const atelierHelpPayloadSchema = z.object({
  reason: z.string().refine(isAtelierHelpReason, "Motivo desconhecido."),
  dedupeKey: z.string().min(1),
});

export async function sendAtelierHelp(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof atelierHelpPayloadSchema>,
): Promise<SendWaMessageResult> {
  const parsed = atelierHelpPayloadSchema.parse(input);
  return sendToOwner(db, provider, {
    templateKey: ATELIER_HELP_TEMPLATE,
    vars: { motivo: atelierHelpReasonText(parsed.reason as AtelierHelpReason) },
    dedupeKey: parsed.dedupeKey,
  });
}

// ---------------------------------------------------------------------------
// A montagem na fila: fotos → rascunho com as fotos → "Rascunho pronto".
// ---------------------------------------------------------------------------

export const atelierIntakePayloadSchema = z.object({
  conversationId: z.uuid(),
  triggerWaMessageId: z.uuid(),
  /** Tentativas já esgotadas antes desta (0 na primeira; como o worker conta). */
  attempt: z.number().int().min(0).default(0),
});

export type ProcessAtelierIntakeResult =
  | { created: true; intakeId: string; productId: string; name: string; photos: number; failedPhotos: number }
  | { skipped: "ja_processado" | "mensagem_inexistente" | "desligado" }
  | { failed: "sem_fotos" | "fotos_indisponiveis" | "sem_usuario"; intakeId: string };

function isLastAttempt(attempt: number): boolean {
  return attempt + 1 >= getRetryPolicy("wa.atelier_intake").maxAttempts;
}

async function uniqueSkuFor(db: DbOrTx, name: string): Promise<string> {
  const base = buildSku(skuBaseFromName(name), []);
  const taken = await db
    .select({ sku: productVariants.sku })
    .from(productVariants)
    .where(sql`${productVariants.sku} LIKE ${`${base}%`}`);
  return dedupeSkus([base], new Set(taken.map((row) => row.sku)))[0];
}

async function markIntake(
  db: DbOrTx,
  intakeId: string,
  patch: Partial<typeof atelierIntakes.$inferInsert>,
  now: Date,
): Promise<void> {
  await db
    .update(atelierIntakes)
    .set({ ...patch, updatedAt: now })
    .where(eq(atelierIntakes.id, intakeId));
}

export async function processAtelierIntake(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  input: z.input<typeof atelierIntakePayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<ProcessAtelierIntakeResult> {
  const { conversationId, triggerWaMessageId, attempt } = atelierIntakePayloadSchema.parse(input);
  const now = clock.now ?? (() => new Date());
  const startedAt = now();

  const [trigger] = await db
    .select({
      id: waMessages.id,
      kind: waMessages.kind,
      body: waMessages.body,
      mediaUrl: waMessages.mediaUrl,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(and(eq(waMessages.id, triggerWaMessageId), eq(waMessages.conversationId, conversationId)))
    .limit(1);
  if (!trigger) return { skipped: "mensagem_inexistente" };

  const [intake] = await db
    .select()
    .from(atelierIntakes)
    .where(eq(atelierIntakes.triggerWaMessageId, trigger.id))
    .limit(1);
  if (!intake) return { skipped: "mensagem_inexistente" };
  if (intake.status === "done") return { skipped: "ja_processado" };
  if (!(await isAtelierEnabled(db))) return { skipped: "desligado" };

  const helpDedupe = `wa.atelier_help:intake:${intake.id}`;
  const fail = async (reason: "sem_fotos" | "fotos_indisponiveis" | "sem_usuario"): Promise<ProcessAtelierIntakeResult> => {
    await markIntake(db, intake.id, { status: "failed", errorDetail: reason, processedAt: now() }, now());
    if (reason !== "sem_usuario") {
      await sendToOwner(db, provider, {
        templateKey: ATELIER_HELP_TEMPLATE,
        vars: { motivo: atelierHelpReasonText(reason) },
        dedupeKey: helpDedupe,
      });
    }
    return { failed: reason, intakeId: intake.id };
  };

  // O lote: na primeira passada, as fotos perto do recado; na retomada
  // (tentativa seguinte), as mesmas fotos de antes.
  let photos: IntakeMessage[];
  let note = intake.note;
  let noteKind = intake.noteKind as NoteKind;
  if (intake.photoWaMessageIds.length > 0) {
    const rows = await db
      .select({
        id: waMessages.id,
        kind: waMessages.kind,
        body: waMessages.body,
        mediaUrl: waMessages.mediaUrl,
        createdAt: waMessages.createdAt,
      })
      .from(waMessages)
      .where(inArray(waMessages.id, intake.photoWaMessageIds))
      .orderBy(asc(waMessages.createdAt));
    photos = rows.map((row) => ({ ...row, consumed: false }));
  } else {
    const messages = await loadIntakeMessages(db, {
      conversationId,
      from: new Date(trigger.createdAt.getTime() - INTAKE_WINDOW_MS),
      to: new Date(trigger.createdAt.getTime() + INTAKE_WINDOW_MS),
      excludeIntakeId: intake.id,
    });
    const batch = selectIntakeBatch(messages, { ...trigger, consumed: false }, {});
    photos = batch.photos;
    // O áudio pode ter sido transcrito depois da abertura: o recado atual vale.
    if (batch.note) {
      note = batch.note;
      noteKind = batch.noteKind;
    }
    if (photos.length === 0) return fail("sem_fotos");
    await markIntake(
      db,
      intake.id,
      { photoWaMessageIds: photos.map((photo) => photo.id), photosCount: photos.length, note, noteKind },
      now(),
    );
  }

  const userId = await resolveAtelierActorUserId(db);
  if (!userId) return fail("sem_usuario");

  // As fotos originais, uma a uma (URL expirada = foto de fora, não falha).
  const downloads = await Promise.allSettled(
    photos.map(async (photo) => {
      const media = await provider.downloadMedia({ url: photo.mediaUrl as string, maxBytes: ATELIER_PHOTO_MAX_BYTES });
      return { photo, data: media.data, contentType: media.contentType ?? "image/jpeg" };
    }),
  );
  const available = downloads.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
  for (const outcome of downloads) {
    if (outcome.status === "rejected") {
      console.warn("[atelier] foto da chegada não baixou:", outcome.reason?.message ?? outcome.reason);
    }
  }
  if (available.length === 0) return fail("fotos_indisponiveis");

  const name = draftNameFromNote(note, startedAt);
  try {
    let productId: string;
    if (intake.productId) {
      productId = intake.productId;
    } else {
      const sku = await uniqueSkuFor(db, name);
      const created = await createProduct(db as unknown as ServiceDb, {
        name,
        description: note ? `Recado da chegada: ${note}` : undefined,
        variants: [{ sku, attributes: {} }],
        userId,
      });
      productId = created.product.id;
      await markIntake(db, intake.id, { productId }, now());
    }

    // Retomada: as fotos que já entraram ficam; só as que faltam sobem.
    const [{ existing }] = await db
      .select({ existing: sql<number>`count(*)::int` })
      .from(productImages)
      .where(eq(productImages.productId, productId));
    let added = 0;
    let failedPhotos = 0;
    for (const item of available.slice(existing)) {
      try {
        await addProductImage(db as unknown as ServiceDb, storage, {
          productId,
          data: item.data,
          contentType: item.contentType.startsWith("image/") ? item.contentType : "image/jpeg",
          userId,
        });
        added += 1;
      } catch (error) {
        failedPhotos += 1;
        console.warn("[atelier] foto não entrou na ficha:", error instanceof Error ? error.message : error);
      }
    }
    const photosOnProduct = existing + added;
    failedPhotos += photos.length - available.length;

    await markIntake(
      db,
      intake.id,
      {
        status: "done",
        productId,
        photosCount: photosOnProduct,
        errorDetail: failedPhotos > 0 ? `${failedPhotos} foto(s) ficaram de fora` : null,
        processedAt: now(),
      },
      now(),
    );
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "atelier.intake",
      entityType: "atelier_intake",
      entityId: intake.id,
      after: {
        productId,
        name,
        noteKind,
        noteChars: note.length,
        photos: photosOnProduct,
        failedPhotos,
        ms: now().getTime() - startedAt.getTime(),
      },
    });

    await sendToOwner(db, provider, {
      templateKey: ATELIER_DRAFT_TEMPLATE,
      vars: atelierDraftVars({ name, photos: photosOnProduct, link: `${siteBaseUrl()}/admin/produtos/${productId}` }),
      dedupeKey: `wa.atelier_draft:${intake.id}`,
    });

    return { created: true, intakeId: intake.id, productId, name, photos: photosOnProduct, failedPhotos };
  } catch (error) {
    // Erro de verdade (banco, storage): a fila tenta de novo; na última
    // tentativa a dona fica sabendo em vez de esperar um rascunho que não vem.
    await markIntake(
      db,
      intake.id,
      { status: "failed", errorDetail: error instanceof Error ? error.message.slice(0, 500) : String(error) },
      now(),
    );
    if (isLastAttempt(attempt)) {
      await sendToOwner(db, provider, {
        templateKey: ATELIER_HELP_TEMPLATE,
        vars: { motivo: atelierHelpReasonText("erro") },
        dedupeKey: helpDedupe,
      });
    }
    throw error;
  }
}

/** A chegada que gerou este produto (selo "Chegou pelo WhatsApp" na ficha). */
export async function getAtelierIntakeForProduct(
  db: DbOrTx,
  productId: string,
): Promise<{ id: string; note: string; photosCount: number; createdAt: Date } | null> {
  const [row] = await db
    .select({
      id: atelierIntakes.id,
      note: atelierIntakes.note,
      photosCount: atelierIntakes.photosCount,
      createdAt: atelierIntakes.createdAt,
    })
    .from(atelierIntakes)
    .where(eq(atelierIntakes.productId, productId))
    .orderBy(desc(atelierIntakes.createdAt))
    .limit(1);
  return row ?? null;
}
