// O cartão do Ateliê: depois do "Rascunho pronto", a dona recebe a imagem
// noir/ouro com a foto da peça recém-chegada e o resumo da chegada (grade,
// peças, custo, fornecedor, a pagar), com o link da ficha na legenda.
// Melhor esforço, pela fila: sem foto na ficha não há cartão (o texto já
// foi); a imagem fica no Storage e o caminho na chegada, então a reentrada
// não desenha de novo e o envio tem dedupe por chegada.
import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { parseAtelierParsed } from "@/core/atelier/proposal";
import { atelierCardLines } from "@/core/atelier/purchase";
import { arrivalDetailsLine } from "@/core/atelier/reply";
import { ATELIER_EYEBROW, cardFrameSize, type AtelierCardData } from "@/core/cards/types";
import { atelierIntakes, financialEntries, productImages, products, suppliers } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { loadCardPhotoDataUrl, PhotoUnavailableError, type CardRenderer } from "@/services/bot-cards";
import { getSettingsMap } from "@/services/settings";
import { sendToOwner, siteBaseUrl, type SendWaMessageResult } from "@/services/wa-messaging";

export const ATELIER_CARD_EVENT = "wa.atelier_card";
export const ATELIER_CARD_TEMPLATE = "owner_atelier_card";
export const ATELIER_CARD_JPEG_QUALITY = 85;

export const atelierCardPayloadSchema = z.object({ intakeId: z.uuid() });

/** Caminho no Storage, datado: a reentrada reaproveita o que já está na chegada. */
export function atelierCardStoragePath(intakeId: string, at: Date): string {
  return `atelier/${intakeId}/card-${at.getTime()}.jpg`;
}

export async function enqueueAtelierCard(tx: DbOrTx, intakeId: string): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: ATELIER_CARD_EVENT,
    dedupeKey: `wa.atelier_card:${intakeId}`,
    aggregateType: "atelier_intake",
    aggregateId: intakeId,
    payload: { intakeId },
  });
}

export type AtelierCardResult =
  | (SendWaMessageResult & { cardUrl: string })
  | { skipped: "chegada_inexistente" | "sem_produto" | "sem_foto" };

export async function renderAndSendAtelierCard(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  render: CardRenderer,
  input: z.input<typeof atelierCardPayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<AtelierCardResult> {
  const { intakeId } = atelierCardPayloadSchema.parse(input);
  const now = clock.now ?? (() => new Date());

  const [intake] = await db
    .select({
      id: atelierIntakes.id,
      productId: atelierIntakes.productId,
      parsed: atelierIntakes.parsed,
      cardPath: atelierIntakes.cardPath,
      productName: products.name,
      productSlug: products.slug,
      supplierName: suppliers.name,
      payableCents: financialEntries.amountCents,
    })
    .from(atelierIntakes)
    .leftJoin(products, eq(products.id, atelierIntakes.productId))
    .leftJoin(suppliers, eq(suppliers.id, atelierIntakes.supplierId))
    .leftJoin(financialEntries, eq(financialEntries.id, atelierIntakes.financialEntryId))
    .where(eq(atelierIntakes.id, intakeId))
    .limit(1);
  if (!intake) return { skipped: "chegada_inexistente" };
  if (!intake.productId || !intake.productName || !intake.productSlug) return { skipped: "sem_produto" };

  const parsed = parseAtelierParsed(intake.parsed);
  const proposal = parsed?.proposal ?? null;
  const suggestedPriceCents = parsed?.suggestedPriceCents ?? null;

  let path = intake.cardPath;
  if (!path) {
    const [image] = await db
      .select({ storagePath: productImages.storagePath })
      .from(productImages)
      .where(eq(productImages.productId, intake.productId))
      .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt))
      .limit(1);
    if (!image) return { skipped: "sem_foto" };

    let imageDataUrl: string;
    try {
      imageDataUrl = await loadCardPhotoDataUrl(storage, image.storagePath, cardFrameSize("atelier", "hero", 1));
    } catch (error) {
      if (error instanceof PhotoUnavailableError) return { skipped: "sem_foto" };
      throw error;
    }
    const settingsMap = await getSettingsMap(db, ["store_name"]);
    const storeName = typeof settingsMap["store_name"] === "string" && settingsMap["store_name"].trim() !== "" ? settingsMap["store_name"] : "TRIVÉ";
    const data: AtelierCardData = {
      kind: "atelier",
      storeName,
      eyebrow: ATELIER_EYEBROW,
      title: intake.productName,
      hero: {
        slug: intake.productSlug,
        name: intake.productName,
        priceLabel: suggestedPriceCents !== null ? `sugerido ${formatCentsBRL(suggestedPriceCents)}` : "",
        imageDataUrl,
      },
      lines: atelierCardLines({
        colors: proposal?.colors.length ?? 0,
        sizes: proposal?.sizes.length ?? 0,
        totalQuantity: proposal?.totalQuantity ?? null,
        unitCostCents: proposal?.unitCostCents ?? null,
        supplierName: intake.supplierName ?? proposal?.supplierName ?? null,
        payableCents: intake.payableCents ?? null,
      }),
    };
    const png = await render(data);
    const jpeg = await sharp(png).jpeg({ quality: ATELIER_CARD_JPEG_QUALITY }).toBuffer();
    path = atelierCardStoragePath(intakeId, now());
    await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
    await db.update(atelierIntakes).set({ cardPath: path, updatedAt: now() }).where(eq(atelierIntakes.id, intakeId));
  }

  const cardUrl = storage.publicUrl(path);
  const result = await sendToOwner(db, provider, {
    templateKey: ATELIER_CARD_TEMPLATE,
    vars: {
      peca: intake.productName,
      detalhes: arrivalDetailsLine(proposal, suggestedPriceCents),
      link: `${siteBaseUrl()}/admin/produtos/${intake.productId}`,
    },
    dedupeKey: `wa.atelier_card:${intakeId}`,
    image: { url: cardUrl },
  });
  return { ...result, cardUrl };
}
