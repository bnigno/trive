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

import { AssistantUnavailableError, type BotImageInput, type SalesAssistant } from "@/adapters/assistant";
import type { FileStorage } from "@/adapters/storage";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import type { MessagingProvider } from "@/adapters/zapi";
import { estimateUsageCostUsdCents } from "@/core/ai/model-cost";
import { expandArrivalGrid } from "@/core/atelier/grid";
import {
  ARRIVAL_JSON_SCHEMA,
  normalizeArrivalProposal,
  parseAtelierParsed,
  type AtelierParsed,
} from "@/core/atelier/proposal";
import { arrivalUserText, buildArrivalPrompt } from "@/core/atelier/prompt";
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
  arrivalDetailsLine,
  atelierDraftVars,
  atelierHelpReasonText,
  isAtelierHelpReason,
  type AtelierHelpReason,
} from "@/core/atelier/reply";
import { formatCareNotes } from "@/core/catalog/care";
import { formatCentsBRL } from "@/lib/money";
import { buildSku, dedupeSkus, skuBaseFromName } from "@/core/catalog/sku";
import type { SelectedVariant } from "@/core/catalog/variant-grid";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import {
  atelierIntakes,
  auditLog,
  categories,
  financialEntries,
  productVariants,
  settings,
  suppliers,
  users,
  waConversations,
  waMessages,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { enqueueAtelierCard } from "@/services/atelier-card";
import { receiveArrivalPurchase, type ArrivalPurchaseResult } from "@/services/atelier-purchase";
import { addProductImage, createProduct, type ServiceDb } from "@/services/catalog";
import { suggestPriceForCost, type PricingDb } from "@/services/pricing";
import { getSettingsMap } from "@/services/settings";
import { getStoreMap } from "@/services/store-catalog";
import { listSuppliers } from "@/services/suppliers";
import { isBotMediaEnabled, prepareImageForModel } from "@/services/wa-media";
import { sendToOwner, siteBaseUrl, type SendWaMessageResult } from "@/services/wa-messaging";

/** Foto original da câmera (a ficha reduz depois); acima disso a foto fica de fora. */
export const ATELIER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** Cada download tem este teto; a função da fila tem 60 s para tudo. */
export const ATELIER_DOWNLOAD_TIMEOUT_MS = 10_000;
/** A inteligência lê o recado e as fotos dentro disto; passou, a ficha nasce simples. */
export const ARRIVAL_MODEL_BUDGET_MS = 25_000;
/** Depois da inteligência ainda vêm o produto, as fotos e o aviso: reserva de tempo. */
export const ARRIVAL_AFTER_MODEL_RESERVE_MS = 12_000;
/** Com menos que isto para a inteligência, nem chama: a ficha nasce simples e a dona não espera à toa. */
export const ARRIVAL_MODEL_MIN_BUDGET_MS = 6_000;
const DEFAULT_ARRIVAL_MODEL = "claude-sonnet-5";
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
  /** Até quando o worker da fila deixa esta chegada rodar (a inteligência se encolhe para caber). */
  deadlineAt: z.date().optional(),
});

export type ProcessAtelierIntakeResult =
  | { created: true; intakeId: string; productId: string; name: string; photos: number; failedPhotos: number; interpreted: boolean }
  | { skipped: "ja_processado" | "mensagem_inexistente" | "desligado" }
  | { failed: "sem_fotos" | "fotos_indisponiveis" | "sem_usuario"; intakeId: string };

function isLastAttempt(attempt: number): boolean {
  return attempt + 1 >= getRetryPolicy("wa.atelier_intake").maxAttempts;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error("tempo esgotado"));
    }, ms);
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

/** SKUs da leva sem colidir com o que já existe no catálogo (sufixo -2, -3…). */
async function withUniqueSkus<T extends { sku: string }>(db: DbOrTx, name: string, variants: readonly T[]): Promise<T[]> {
  const base = skuBaseFromName(name);
  const taken = await db
    .select({ sku: productVariants.sku })
    .from(productVariants)
    .where(sql`${productVariants.sku} LIKE ${`${base}%`}`);
  const skus = dedupeSkus(
    variants.map((variant) => variant.sku),
    new Set(taken.map((row) => row.sku)),
  );
  return variants.map((variant, index) => ({ ...variant, sku: skus[index] }));
}

/**
 * A inteligência lê o recado (fonte principal) e as fotos (apoio) e devolve
 * a proposta da chegada. Qualquer falha (sem chave, demora, JSON torto) vira
 * `failed` — a ficha nasce simples, como no C-A, nunca trava a chegada.
 */
export async function interpretArrival(
  db: DbOrTx,
  assistant: SalesAssistant,
  input: {
    note: string;
    images: readonly Buffer[];
    now: () => Date;
    /** Até quando a chegada inteira precisa terminar (o worker da fila tem um teto). */
    deadlineAt?: Date;
  },
): Promise<AtelierParsed> {
  const startedAt = input.now().getTime();
  const elapsed = () => input.now().getTime() - startedAt;
  const base: AtelierParsed = {
    proposal: null,
    suggestedPriceCents: null,
    model: DEFAULT_ARRIVAL_MODEL,
    usage: null,
    estimatedCostUsdCents: 0,
    ms: 0,
    failed: null,
  };

  // O tempo que sobra para a inteligência, descontada a reserva do que vem
  // depois; pouco demais = nem chama (a ficha nasce simples).
  const budgetMs = input.deadlineAt
    ? Math.min(ARRIVAL_MODEL_BUDGET_MS, input.deadlineAt.getTime() - startedAt - ARRIVAL_AFTER_MODEL_RESERVE_MS)
    : ARRIVAL_MODEL_BUDGET_MS;
  if (budgetMs < ARRIVAL_MODEL_MIN_BUDGET_MS) {
    console.warn(`[atelier] sem tempo para a inteligência (${budgetMs} ms): ficha simples`);
    return { ...base, failed: "sem_tempo", ms: elapsed() };
  }

  let system: string;
  let categoryRows: { id: string; name: string; slug: string }[];
  let model = DEFAULT_ARRIVAL_MODEL;
  let images: BotImageInput[] = [];
  try {
    const [settingsMap, rows, storeMap, suppliers] = await Promise.all([
      getSettingsMap(db as unknown as ServiceDb, ["store_name", "store_manifesto", "bot_model"]),
      db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).orderBy(asc(categories.name)),
      getStoreMap(db as unknown as ServiceDb),
      listSuppliers(db as unknown as ServiceDb),
    ]);
    categoryRows = rows;
    const text = (key: string): string => (typeof settingsMap[key] === "string" ? (settingsMap[key] as string) : "");
    model = text("bot_model").trim() !== "" ? text("bot_model").trim() : DEFAULT_ARRIVAL_MODEL;
    // Foto que o sharp não abre (HEIC…) fica de fora do modelo; o recado basta.
    const prepared = await Promise.allSettled(input.images.map((data) => prepareImageForModel(data)));
    images = prepared.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [{ mediaType: outcome.value.mediaType, base64: outcome.value.base64 }] : [],
    );
    system = buildArrivalPrompt({
      storeName: text("store_name").trim() !== "" ? text("store_name").trim() : "TRIVÉ",
      manifesto: text("store_manifesto"),
      categories: categoryRows.map((row) => ({ name: row.name, slug: row.slug })),
      knownColors: storeMap.colors,
      knownSizes: storeMap.sizes,
      knownSuppliers: suppliers.map((supplier) => supplier.name),
    });
  } catch (error) {
    // Leitura de apoio falhou (banco): a ficha nasce simples, nunca trava.
    console.warn("[atelier] apoio da inteligência indisponível:", error instanceof Error ? error.message : error);
    return { ...base, model, failed: "ia_erro", ms: elapsed() };
  }
  base.model = model;

  const controller = new AbortController();
  let extraction;
  try {
    extraction = await withTimeout(
      assistant.extractFromPhotos({
        system,
        images,
        userText: arrivalUserText(input.note),
        model,
        jsonSchema: ARRIVAL_JSON_SCHEMA,
        signal: controller.signal,
      }),
      budgetMs,
      () => controller.abort(),
    );
  } catch (error) {
    const failed =
      error instanceof AssistantUnavailableError
        ? "ia_indisponivel"
        : error instanceof Error && error.message === "tempo esgotado"
          ? "ia_demorou"
          : "ia_erro";
    console.warn(`[atelier] inteligência não respondeu (${failed}):`, error instanceof Error ? error.message : error);
    return { ...base, failed, ms: elapsed() };
  }
  const usage = extraction.usage;
  const estimatedCostUsdCents = estimateUsageCostUsdCents(usage, model);
  try {
    const proposal = normalizeArrivalProposal(extraction.json, { categories: categoryRows });
    return { ...base, proposal, usage, estimatedCostUsdCents, ms: elapsed() };
  } catch (error) {
    console.warn("[atelier] resposta da inteligência fora do formato:", error instanceof Error ? error.message : error);
    return { ...base, usage, estimatedCostUsdCents, failed: "json_invalido", ms: elapsed() };
  }
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
  assistant: SalesAssistant,
  input: z.input<typeof atelierIntakePayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<ProcessAtelierIntakeResult> {
  const { conversationId, triggerWaMessageId, attempt, deadlineAt } = atelierIntakePayloadSchema.parse(input);
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

  // A inteligência lê o recado e as fotos UMA vez, antes de criar o produto,
  // e a leitura é gravada na hora (fora da transação do produto): a retomada
  // reaproveita, e com produto já criado nunca se chama de novo — a grade
  // é a que o produto tem.
  let interpreted = parseAtelierParsed(intake.parsed);
  if (!interpreted && intake.productId) {
    interpreted = { proposal: null, suggestedPriceCents: null, model: "", usage: null, estimatedCostUsdCents: 0, ms: 0, failed: "sem_interpretacao" };
  }
  if (!interpreted) {
    interpreted = await interpretArrival(db, assistant, { note, images: available.map((item) => item.data), now, deadlineAt });
    await markIntake(db, intake.id, { parsed: interpreted }, now());
  }
  let proposal = interpreted.proposal;
  const name = proposal?.name || draftNameFromNote(note, startedAt);
  try {
    let productId: string;
    if (intake.productId) {
      productId = intake.productId;
    } else {
      // Com proposta, a grade cor × tamanho com o custo por peça (o estoque
      // entra no próximo passo do Ateliê); sem ela, a ficha simples.
      const grid = proposal ? expandArrivalGrid(name, proposal) : { axes: [] as string[], variants: [] as SelectedVariant[] };
      const variants = await withUniqueSkus(
        db,
        name,
        grid.variants.length > 0 ? grid.variants : [{ sku: buildSku(skuBaseFromName(name), []), attributes: {}, initialQuantity: 0 }],
      );
      if (proposal?.unitCostCents) {
        try {
          interpreted.suggestedPriceCents = (await suggestPriceForCost(db as unknown as PricingDb, proposal.unitCostCents))?.priceCents ?? null;
        } catch {
          interpreted.suggestedPriceCents = null;
        }
      }
      const stored = interpreted;
      const simpleDescription = note ? `Recado da chegada: ${note}`.slice(0, 1200) : undefined;
      const fullInput = {
        name,
        description: proposal?.description || simpleDescription,
        composition: proposal?.composition || undefined,
        careNotes: proposal ? (formatCareNotes(proposal.careSymbols, proposal.careFreeText) ?? undefined) : undefined,
        fitNotes: proposal?.fitNotes || undefined,
        categoryId: proposal?.categoryId ?? undefined,
        attributesSchema: grid.axes,
        variants,
        userId,
      };
      // Produto e vínculo com a chegada na MESMA transação: uma queda entre
      // os dois não deixa um rascunho órfão que a retomada duplicaria. Se a
      // ficha recusar a proposta (texto além do limite, valor torto), a peça
      // nasce simples em vez de travar a chegada.
      const create = (productInput: Parameters<typeof createProduct>[1]) =>
        db.transaction(async (tx) => {
          const created = await createProduct(tx as unknown as ServiceDb, productInput);
          await markIntake(tx, intake.id, { productId: created.product.id, note, noteKind, parsed: stored }, now());
          return created.product.id;
        });
      try {
        productId = await create(fullInput);
      } catch (error) {
        if (!proposal || !(error instanceof z.ZodError || (error instanceof Error && error.name === "ServiceError"))) throw error;
        console.warn("[atelier] a ficha recusou a proposta; peça simples:", error instanceof Error ? error.message : error);
        stored.failed = "ficha_recusou";
        stored.proposal = null;
        // Sem a grade não há compra pela grade: a proposta some daqui em diante.
        proposal = null;
        productId = await create({
          name,
          description: simpleDescription,
          variants: await withUniqueSkus(db, name, [{ sku: buildSku(skuBaseFromName(name), []), attributes: {}, initialQuantity: 0 }]),
          userId,
        });
      }
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

    // A chegada vira compra (fornecedor do recado, estoque com custo em cada
    // variação, UMA conta a pagar) — idempotente por chegada; o que falhar
    // aqui fica anotado e não derruba o rascunho.
    const purchase: ArrivalPurchaseResult = await receiveArrivalPurchase(db, {
      intakeId: intake.id,
      productId,
      productName: name,
      proposal,
      existing: { supplierId: intake.supplierId, financialEntryId: intake.financialEntryId },
      userId,
      now,
    });

    // O aviso sai ANTES do "done": se o provedor falhar, a chegada continua
    // por fechar e a retomada só reenvia (dedupe por chegada); "done" e o
    // audit entram uma vez só. WhatsApp desligado não é erro — fica anotado.
    const detailsLine =
      arrivalDetailsLine(proposal, interpreted.suggestedPriceCents) +
      (purchase.payableCents !== null ? ` · a pagar ${formatCentsBRL(purchase.payableCents)}` : "") +
      (purchase.purchaseError ? " · compra NÃO lançada (veja a ficha)" : "") +
      (purchase.supplierError ? " · fornecedor por escolher na ficha" : "") +
      (interpreted.failed === "ficha_recusou"
        ? " · a ficha recusou a grade: peça simples (complete no painel)"
        : interpreted.failed
          ? " · sem a grade (a inteligência não respondeu)"
          : "");
    const notice = await sendToOwner(db, provider, {
      templateKey: ATELIER_DRAFT_TEMPLATE,
      vars: atelierDraftVars({ name, photos: photosOnProduct, link: `${siteBaseUrl()}/admin/produtos/${productId}`, details: detailsLine }),
      dedupeKey: `wa.atelier_draft:${intake.id}`,
    });
    const details = [
      failedPhotos > 0 ? `${failedPhotos} foto(s) ficaram de fora` : null,
      "skipped" in notice ? `aviso não enviado: ${notice.skipped}` : null,
      purchase.supplierError
        ? `${purchase.movements > 0 ? `estoque lançado (${purchase.totalQuantity ?? purchase.movements} peças); ` : ""}fornecedor não ligado e conta a pagar não criada — ${purchase.supplierError}`
        : null,
      purchase.purchaseError ? `compra não lançada — ${purchase.purchaseError}` : null,
    ].filter((line): line is string => line !== null);
    // O que a compra fez fica com a leitura, para a ficha contar a história certa.
    const parsedWithPurchase: AtelierParsed = {
      ...interpreted,
      purchase: {
        movements: purchase.movements,
        totalQuantity: purchase.totalQuantity,
        skipped: purchase.skipped,
        supplierError: purchase.supplierError,
        purchaseError: purchase.purchaseError,
      },
    };

    // "done", o audit e o cartão (fila) na MESMA transação.
    await db.transaction(async (tx) => {
      await markIntake(
        tx,
        intake.id,
        {
          status: "done",
          productId,
          photosCount: photosOnProduct,
          errorDetail: details.length > 0 ? details.join("; ") : null,
          parsed: parsedWithPurchase,
          processedAt: now(),
        },
        now(),
      );
      await tx.insert(auditLog).values({
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
          interpreted: proposal !== null,
          interpretationFailed: interpreted.failed,
          model: interpreted.model,
          usage: interpreted.usage,
          estimatedCostUsdCents: interpreted.estimatedCostUsdCents,
          variants: variantsCount(proposal),
          purchase: {
            supplierId: purchase.supplierId,
            supplierCreated: purchase.supplierCreated,
            financialEntryId: purchase.financialEntryId,
            payableCents: purchase.payableCents,
            totalQuantity: purchase.totalQuantity,
            movements: purchase.movements,
            skipped: purchase.skipped,
            supplierError: purchase.supplierError,
            purchaseError: purchase.purchaseError,
          },
          ms: now().getTime() - startedAt.getTime(),
        },
      });
      if (photosOnProduct > 0) await enqueueAtelierCard(tx, intake.id);
    });

    return { created: true, intakeId: intake.id, productId, name, photos: photosOnProduct, failedPhotos, interpreted: proposal !== null };
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

function variantsCount(proposal: AtelierParsed["proposal"]): number {
  return proposal ? proposal.variantCount : 1;
}

/** A chegada que gerou este produto (bloco "Como chegou pelo WhatsApp" na ficha). */
export async function getAtelierIntakeForProduct(
  db: DbOrTx,
  productId: string,
): Promise<{
  id: string;
  note: string;
  photosCount: number;
  createdAt: Date;
  parsed: AtelierParsed | null;
  errorDetail: string | null;
  supplier: { id: string; name: string } | null;
  payable: { id: string; amountCents: number; status: string } | null;
  cardPath: string | null;
} | null> {
  const [row] = await db
    .select({
      id: atelierIntakes.id,
      note: atelierIntakes.note,
      photosCount: atelierIntakes.photosCount,
      createdAt: atelierIntakes.createdAt,
      parsed: atelierIntakes.parsed,
      errorDetail: atelierIntakes.errorDetail,
      cardPath: atelierIntakes.cardPath,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      payableId: financialEntries.id,
      payableCents: financialEntries.amountCents,
      payableStatus: financialEntries.status,
    })
    .from(atelierIntakes)
    .leftJoin(suppliers, eq(suppliers.id, atelierIntakes.supplierId))
    .leftJoin(financialEntries, eq(financialEntries.id, atelierIntakes.financialEntryId))
    .where(eq(atelierIntakes.productId, productId))
    .orderBy(desc(atelierIntakes.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    note: row.note,
    photosCount: row.photosCount,
    createdAt: row.createdAt,
    parsed: parseAtelierParsed(row.parsed),
    errorDetail: row.errorDetail,
    supplier: row.supplierId && row.supplierName ? { id: row.supplierId, name: row.supplierName } : null,
    payable: row.payableId && row.payableCents !== null && row.payableStatus ? { id: row.payableId, amountCents: row.payableCents, status: row.payableStatus } : null,
    cardPath: row.cardPath,
  };
}
