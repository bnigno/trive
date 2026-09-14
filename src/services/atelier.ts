// Ateliê pelo WhatsApp: a dona manda fotos e um recado do celular DELA para
// o número da maison e a peça nasce em rascunho, com as fotos publicadas
// (full/md/thumb), nada na loja. Duas metades: a decisão no webhook (é a
// dona? é foto, recado ou pedido de ajuda?) e a montagem do rascunho na
// fila (baixa as fotos, cria o produto, responde "Rascunho pronto").
//
// Posse das fotos: a chegada REIVINDICA as fotos no ato de abrir (na mesma
// transação do webhook) e guarda os ids; nenhuma outra chegada as vê. A
// montagem só absorve as fotos que chegaram logo depois do recado e ainda
// não têm dona. A retomada (tentativa seguinte) sobe só o que falta.
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  INTAKE_GRACE_MS,
  INTAKE_LATE_PHOTO_MS,
  INTAKE_WINDOW_MS,
  hasOpenBatch,
  noteFromMessage,
  selectIntakeBatch,
  selectLatePhotos,
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
  productVariants,
  settings,
  users,
  waConversations,
  waMessages,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { addProductImage, createProduct, type ServiceDb } from "@/services/catalog";
import { isBotMediaEnabled } from "@/services/wa-media";
import { sendToOwner, siteBaseUrl, type SendWaMessageResult } from "@/services/wa-messaging";

/** Foto original da câmera (a ficha reduz depois); acima disso a foto fica de fora. */
export const ATELIER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** Cada download tem este teto; a função da fila tem 60 s para tudo. */
export const ATELIER_DOWNLOAD_TIMEOUT_MS = 12_000;
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
 * As mensagens recebidas desse telefone num período — em QUALQUER conversa
 * dele (a conversa pode ter sido encerrada no painel entre a foto e o
 * recado) — com a marca "já reivindicada por uma chegada".
 */
async function loadIntakeMessages(
  db: DbOrTx,
  input: { phoneE164: string; from: Date; to: Date },
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
    .innerJoin(waConversations, eq(waConversations.id, waMessages.conversationId))
    .where(
      and(
        eq(waConversations.phoneE164, input.phoneE164),
        eq(waMessages.direction, "inbound"),
        gte(waMessages.createdAt, input.from),
        lte(waMessages.createdAt, input.to),
      ),
    )
    .orderBy(asc(waMessages.createdAt));
  if (rows.length === 0) return [];

  const claims = await db
    .select({ photoWaMessageIds: atelierIntakes.photoWaMessageIds })
    .from(atelierIntakes)
    .innerJoin(waConversations, eq(waConversations.id, atelierIntakes.conversationId))
    .where(
      and(
        eq(waConversations.phoneE164, input.phoneE164),
        gte(atelierIntakes.createdAt, new Date(input.from.getTime() - INTAKE_WINDOW_MS)),
      ),
    );
  const claimed = new Set(claims.flatMap((claim) => claim.photoWaMessageIds));
  return rows.map((row) => ({ ...row, consumed: claimed.has(row.id) }));
}

export async function hasOpenAtelierBatch(db: DbOrTx, phoneE164: string, now: Date): Promise<boolean> {
  const messages = await loadIntakeMessages(db, {
    phoneE164,
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
    phoneE164: string;
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
  if (await hasOpenAtelierBatch(db, input.phoneE164, input.now)) return { kind: "intake" };
  return input.kind === "note" ? { kind: "help", reason: "sem_fotos" } : { kind: "normal" };
}

/**
 * Abre a chegada na MESMA transação do webhook: reivindica as fotos do
 * lote (o recado é o gatilho; a reentrega da Z-API bate no UNIQUE e não
 * duplica) e agenda a montagem para depois do respiro — a última foto às
 * vezes chega depois do recado e a montagem a absorve.
 */
export async function openAtelierIntake(
  tx: DbOrTx,
  input: {
    conversationId: string;
    phoneE164: string;
    triggerWaMessageId: string;
    zapiMessageId: string;
    kind: string;
    body: string;
    now: Date;
  },
): Promise<string | null> {
  const [trigger] = await tx
    .select({ id: waMessages.id, mediaUrl: waMessages.mediaUrl, createdAt: waMessages.createdAt })
    .from(waMessages)
    .where(eq(waMessages.id, input.triggerWaMessageId))
    .limit(1);
  if (!trigger) return null;
  const messages = await loadIntakeMessages(tx, {
    phoneE164: input.phoneE164,
    from: new Date(trigger.createdAt.getTime() - INTAKE_WINDOW_MS),
    to: new Date(trigger.createdAt.getTime() + 60_000),
  });
  const batch = selectIntakeBatch(
    messages,
    { id: trigger.id, kind: input.kind, body: input.body, mediaUrl: trigger.mediaUrl, createdAt: trigger.createdAt, consumed: false },
  );

  const [intake] = await tx
    .insert(atelierIntakes)
    .values({
      conversationId: input.conversationId,
      triggerWaMessageId: input.triggerWaMessageId,
      note: batch.note,
      noteKind: batch.noteKind,
      photoWaMessageIds: batch.photos.map((photo) => photo.id),
      photosCount: batch.photos.length,
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tempo esgotado")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

async function loadPhotos(db: DbOrTx, ids: readonly string[]): Promise<IntakeMessage[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: waMessages.id,
      kind: waMessages.kind,
      body: waMessages.body,
      mediaUrl: waMessages.mediaUrl,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(inArray(waMessages.id, [...ids]))
    .orderBy(asc(waMessages.createdAt));
  return rows.map((row) => ({ ...row, consumed: false }));
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
      phoneE164: waConversations.phoneE164,
    })
    .from(waMessages)
    .innerJoin(waConversations, eq(waConversations.id, waMessages.conversationId))
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

  // O lote: as fotos reivindicadas ao abrir + as que chegaram logo depois
  // do recado e ninguém reivindicou (só na primeira passada, antes de
  // haver produto — a retomada trabalha com o conjunto já fixado).
  let photoIds = [...intake.photoWaMessageIds];
  if (!intake.productId) {
    const recent = await loadIntakeMessages(db, {
      phoneE164: trigger.phoneE164,
      from: trigger.createdAt,
      to: new Date(trigger.createdAt.getTime() + INTAKE_LATE_PHOTO_MS + 1_000),
    });
    const late = selectLatePhotos(recent, { ...trigger, consumed: false }, photoIds.length);
    if (late.length > 0) {
      photoIds = [...photoIds, ...late.map((photo) => photo.id)];
      await markIntake(db, intake.id, { photoWaMessageIds: photoIds, photosCount: photoIds.length }, now());
    }
  }
  const photos = await loadPhotos(db, photoIds);
  if (photos.length === 0) return fail("sem_fotos");

  // O recado pode ter sido transcrito depois da abertura: o texto atual vale.
  const current = noteFromMessage({ kind: trigger.kind, body: trigger.body });
  const note = current.note || intake.note;
  const noteKind: NoteKind = current.note ? current.noteKind : (intake.noteKind as NoteKind);

  const userId = await resolveAtelierActorUserId(db);
  if (!userId) return fail("sem_usuario");

  // As fotos originais, uma a uma, cada uma com o próprio teto de tempo
  // (URL expirada ou lenta = foto de fora, não falha da chegada).
  const uploaded = new Set(intake.uploadedWaMessageIds);
  const pendingPhotos = photos.filter((photo) => !uploaded.has(photo.id));
  const downloads = await Promise.allSettled(
    pendingPhotos.map((photo) =>
      withTimeout(
        (async () => {
          const media = await provider.downloadMedia({ url: photo.mediaUrl as string, maxBytes: ATELIER_PHOTO_MAX_BYTES });
          return { photo, data: media.data, contentType: media.contentType ?? "image/jpeg" };
        })(),
        ATELIER_DOWNLOAD_TIMEOUT_MS,
      ),
    ),
  );
  const available = downloads.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
  for (const outcome of downloads) {
    if (outcome.status === "rejected") {
      console.warn("[atelier] foto da chegada não baixou:", outcome.reason?.message ?? outcome.reason);
    }
  }
  if (available.length === 0 && uploaded.size === 0) return fail("fotos_indisponiveis");

  const name = draftNameFromNote(note, startedAt);
  try {
    let productId: string;
    if (intake.productId) {
      productId = intake.productId;
    } else {
      // Produto e vínculo com a chegada na MESMA transação: uma queda entre
      // os dois não deixa um rascunho órfão que a retomada duplicaria.
      const sku = await uniqueSkuFor(db, name);
      productId = await db.transaction(async (tx) => {
        const created = await createProduct(tx as unknown as ServiceDb, {
          name,
          description: note ? `Recado da chegada: ${note}`.slice(0, 1200) : undefined,
          variants: [{ sku, attributes: {} }],
          userId,
        });
        await markIntake(tx, intake.id, { productId: created.product.id, note, noteKind }, now());
        return created.product.id;
      });
    }

    let failedPhotos = pendingPhotos.length - available.length;
    for (const item of available) {
      try {
        await addProductImage(db as unknown as ServiceDb, storage, {
          productId,
          data: item.data,
          contentType: item.contentType.startsWith("image/") ? item.contentType : "image/jpeg",
          userId,
        });
        uploaded.add(item.photo.id);
        await markIntake(db, intake.id, { uploadedWaMessageIds: [...uploaded] }, now());
      } catch (error) {
        failedPhotos += 1;
        console.warn("[atelier] foto não entrou na ficha:", error instanceof Error ? error.message : error);
      }
    }
    const photosOnProduct = uploaded.size;

    // O aviso sai ANTES do "done": se o provedor falhar, a chegada continua
    // por fechar e a retomada só reenvia (dedupe por chegada); "done" e o
    // audit entram uma vez só. WhatsApp desligado não é erro — fica anotado.
    const notice = await sendToOwner(db, provider, {
      templateKey: ATELIER_DRAFT_TEMPLATE,
      vars: atelierDraftVars({ name, photos: photosOnProduct, link: `${siteBaseUrl()}/admin/produtos/${productId}` }),
      dedupeKey: `wa.atelier_draft:${intake.id}`,
    });
    const details = [
      failedPhotos > 0 ? `${failedPhotos} foto(s) ficaram de fora` : null,
      "skipped" in notice ? `aviso não enviado: ${notice.skipped}` : null,
    ].filter((line): line is string => line !== null);

    await markIntake(
      db,
      intake.id,
      {
        status: "done",
        productId,
        photosCount: photosOnProduct,
        errorDetail: details.length > 0 ? details.join("; ") : null,
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
        notice: "skipped" in notice ? notice.skipped : "sent",
        ms: now().getTime() - startedAt.getTime(),
      },
    });

    return { created: true, intakeId: intake.id, productId, name, photos: photosOnProduct, failedPhotos };
  } catch (error) {
    // Erro de verdade (banco, storage, envio): a fila tenta de novo; na
    // última tentativa a dona fica sabendo em vez de esperar um rascunho.
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
