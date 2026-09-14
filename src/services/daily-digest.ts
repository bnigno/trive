// "Bom dia da maison": todo dia às 8h (SP) o dono recebe uma imagem com o
// resumo de ontem — vendas, o que espera por ele, o que a vendedora fez,
// estoque baixo e a peça mais vendida. O cron só enfileira `digest.daily`;
// quem monta, desenha e envia é este serviço, chamado pelo handler da fila
// (retry, DLQ e "reprocessar" de graça). Idempotente: path determinístico
// por dia e dedupe wa.digest:<dia>.
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { editionDigestLine } from "@/core/digest/editions";
import { openingFor } from "@/core/digest/openings";
import type { DailyDigestData } from "@/core/digest/types";
import { normalizeReceiptText } from "@/core/receipts/types";
import { auditLog, orders, settings, waMessages, waTemplates } from "@/db/schema";
import { formatCentsBRL, formatUsdCents } from "@/lib/money";
import { isValidE164 } from "@/lib/phone";
import {
  isSpDayKey,
  spDayEnd,
  spDayKey,
  spDayLabel,
  spPreviousDayKey,
  spDayStart,
  spWeekdayName,
  weekdayIndexSP,
} from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { topProducts } from "@/services/reports";
import { getStockOverview } from "@/services/stock";
import { summarizeCityEditionsForDigest } from "@/services/city-editions";
import { countOrdersMustShipToday } from "@/services/needed-by";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { getStoreName } from "@/services/settings";
import { countConversationsAwaitingOwner } from "@/services/wa-conversations";
import { summarizeBotActivity } from "@/services/wa-insights";
import { isWaEnabled, sendToOwner, type SendWaMessageResult } from "@/services/wa-messaging";

export const DIGEST_TEMPLATE_KEY = "owner_daily_digest";
export const DIGEST_JPEG_QUALITY = 88;
const LOW_STOCK_LIMIT = 3;
const BEST_SELLER_DAYS = 7;

/** Quem desenha o PNG (src/receipts/render-digest + assets), injetado pelo handler. */
export type DigestRenderer = (data: DailyDigestData) => Promise<Buffer>;

export function digestStoragePath(dayKey: string): string {
  return `digests/${dayKey}.jpg`;
}

export function digestDedupeKey(dayKey: string): string {
  return `wa.digest:${dayKey}`;
}

/** O dia relatado pelo resumo das 8h: ontem, no calendário de São Paulo. */
export function yesterdaySpDayKey(now: Date = new Date()): string {
  return spPreviousDayKey(spDayKey(now));
}

const dateSchema = z.object({
  date: z.string().refine(isSpDayKey, "Dia inválido (use YYYY-MM-DD)."),
});

const EXCLUDED_STATUSES = ["canceled", "refunded"] as const;

/** Só leitura: os números do dia `date` (janela de São Paulo) e o estado de agora. */
export async function buildDailyDigestData(
  db: DbOrTx,
  input: { date: string },
): Promise<DailyDigestData> {
  const { date } = dateSchema.parse(input);
  const from = spDayStart(date);
  const to = spDayEnd(date);
  // "Precisam sair hoje" é o dia em que o Bom dia chega: o seguinte ao relatado.
  const now = new Date(to.getTime() + 8 * 3_600_000);

  const [sales] = await db
    .select({
      paidOrders: count(),
      revenueCents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
    })
    .from(orders)
    .where(
      and(
        isNotNull(orders.paidAt),
        notInArray(orders.status, [...EXCLUDED_STATUSES]),
        gte(orders.paidAt, from),
        lt(orders.paidAt, to),
      ),
    );
  const [created] = await db
    .select({ value: count() })
    .from(orders)
    .where(and(gte(orders.createdAt, from), lt(orders.createdAt, to)));

  const waitingRows = await db
    .select({
      status: orders.status,
      hasPhoto: sql<boolean>`${orders.packagePhotoPath} is not null`,
      value: count(),
    })
    .from(orders)
    .where(inArray(orders.status, ["pending_payment", "paid", "preparing"]))
    .groupBy(orders.status, sql`${orders.packagePhotoPath} is not null`);
  let pendingPayment = 0;
  let toPack = 0;
  let toShip = 0;
  for (const row of waitingRows) {
    if (row.status === "pending_payment") pendingPayment += row.value;
    else if (row.status === "paid") toPack += row.value;
    else if (row.status === "preparing") {
      if (row.hasPhoto) toShip += row.value;
      else toPack += row.value;
    }
  }

  const [conversationsAwaitingOwner, bot, stock, top, storeName, mustShipToday, editions] = await Promise.all([
    countConversationsAwaitingOwner(db),
    summarizeBotActivity(db, { from, to }),
    getStockOverview(db),
    topProducts(db, { days: BEST_SELLER_DAYS, limit: 1 }),
    getStoreName(db),
    countOrdersMustShipToday(db, { now }),
    // O Bom dia chega na manhã seguinte ao dia relatado: a vigência é a desse dia.
    summarizeCityEditionsForDigest(db, { now: now }),
  ]);

  const lowStock = stock
    .filter((row) => row.low)
    .sort((a, b) => a.available - b.available || a.productName.localeCompare(b.productName))
    .slice(0, LOW_STOCK_LIMIT)
    .map((row) => ({
      name:
        normalizeReceiptText(
          row.variantLabel ? `${row.productName} ${row.variantLabel}` : row.productName,
        ) || "Peça",
      sku: normalizeReceiptText(row.sku),
      available: row.available,
    }));

  const paidOrders = Number(sales?.paidOrders ?? 0);
  const revenueCents = Number(sales?.revenueCents ?? 0);
  const best = top[0];

  return {
    dayKey: date,
    dayLabel: spDayLabel(date),
    weekdayIndex: weekdayIndexSP(date),
    opening: normalizeReceiptText(openingFor(weekdayIndexSP(date), paidOrders > 0)),
    sales: {
      paidOrders,
      revenueCents,
      averageTicketCents: paidOrders > 0 ? Math.round(revenueCents / paidOrders) : 0,
      newOrders: Number(created?.value ?? 0),
    },
    waiting: { pendingPayment, toPack, toShip, conversationsAwaitingOwner, mustShipToday },
    bot,
    lowStock,
    bestSeller: best
      ? {
          name: normalizeReceiptText(best.name) || "Peça",
          quantity: best.quantity,
          revenueCents: best.revenueCents,
        }
      : null,
    editions: editions.map((e) => ({ ...e, name: normalizeReceiptText(e.name) || "Edição" })),
    storeName: normalizeReceiptText(storeName) || STORE_NAME_DEFAULT,
    generatedAt: new Date(),
  };
}

/** Variáveis da legenda (template owner_daily_digest). */
export function buildDigestVars(data: DailyDigestData): Record<string, string> {
  const [, month, day] = data.dayKey.split("-");
  return {
    dia: spWeekdayName(data.dayKey),
    data: `${day}/${month}`,
    vendas: formatCentsBRL(data.sales.revenueCents),
    pedidos: String(data.sales.paidOrders),
    ticket: formatCentsBRL(data.sales.averageTicketCents),
    a_pagar: String(data.waiting.pendingPayment),
    a_embalar: String(data.waiting.toPack),
    a_enviar: String(data.waiting.toShip),
    sair_hoje: String(data.waiting.mustShipToday),
    lia_conversas: String(data.bot.conversations),
    lia_pedidos: String(data.bot.orders),
    lia_custo: formatUsdCents(data.bot.costUsdCents),
    loja: data.storeName,
    // Traz a própria quebra de linha: sem edição, a legenda termina no 🤎 sem linha vazia.
    edicoes: (() => {
      const line = editionDigestLine(data.editions);
      return line ? `\n${line}` : "";
    })(),
  };
}

/**
 * Renderiza, converte para JPEG, sobe com upsert em digests/<dia>.jpg e
 * audita. A URL leva ?v=<agora> para furar o cache da CDN em reenvios.
 */
export async function publishDailyDigest(
  db: DbOrTx,
  storage: FileStorage,
  render: DigestRenderer,
  input: { date: string },
): Promise<{ path: string; url: string; data: DailyDigestData }> {
  const { date } = dateSchema.parse(input);
  const data = await buildDailyDigestData(db, { date });
  const png = await render(data);
  const jpeg = await sharp(png).jpeg({ quality: DIGEST_JPEG_QUALITY }).toBuffer();
  const path = digestStoragePath(date);
  await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "digest.published",
    entityType: "digest",
    entityId: date,
    after: { path, paidOrders: data.sales.paidOrders, revenueCents: data.sales.revenueCents },
  });
  return { path, url: `${storage.publicUrl(path)}?v=${data.generatedAt.getTime()}`, data };
}

export type SendDigestResult =
  | SendWaMessageResult
  | { skipped: "digest_desligado" | "sem_template" };

/**
 * Pré-checa (ligado, WhatsApp, telefone do dono, já enviado, template) ANTES
 * de renderizar; depois publica e manda ao dono como imagem com a legenda do
 * template. `force` (botão "Enviar agora") ignora o "já enviado" com um
 * dedupe próprio — nunca o das 8h.
 */
export async function sendDailyDigestWa(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  render: DigestRenderer,
  input: { date: string; force?: boolean },
): Promise<SendDigestResult> {
  const { date } = dateSchema.parse(input);

  const [toggle] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "owner_digest_enabled"))
    .limit(1);
  if (toggle && toggle.value === false) return { skipped: "digest_desligado" };
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const dedupeKey = input.force
    ? `${digestDedupeKey(date)}:manual:${Date.now()}`
    : digestDedupeKey(date);
  if (!input.force) {
    const [existing] = await db
      .select({ status: waMessages.status })
      .from(waMessages)
      .where(eq(waMessages.dedupeKey, dedupeKey))
      .orderBy(desc(waMessages.createdAt))
      .limit(1);
    if (existing && existing.status !== "failed" && existing.status !== "queued") {
      return { skipped: "ja_enviado" };
    }
  }

  // Telefone do dono e template ANTES de desenhar: sem eles, nem Satori nem JPG.
  const [phoneRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "owner_whatsapp_phone"))
    .limit(1);
  if (typeof phoneRow?.value !== "string" || !isValidE164(phoneRow.value)) {
    return { skipped: "sem_telefone_dono" };
  }
  const [template] = await db
    .select({ isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, DIGEST_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  const { url, data } = await publishDailyDigest(db, storage, render, { date });
  return sendToOwner(db, provider, {
    templateKey: DIGEST_TEMPLATE_KEY,
    vars: buildDigestVars(data),
    dedupeKey,
    image: { url },
  });
}

/** Último resumo publicado (para o link "Ver o último resumo" na Central). */
export async function getLastDigest(
  db: DbOrTx,
): Promise<{ date: string; path: string; at: Date } | null> {
  const [row] = await db
    .select({ entityId: auditLog.entityId, after: auditLog.after, at: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.action, "digest.published"), isNull(auditLog.actorId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row || !row.entityId) return null;
  const after = (row.after ?? {}) as { path?: string };
  if (typeof after.path !== "string") return null;
  return { date: row.entityId, path: after.path, at: row.at };
}
