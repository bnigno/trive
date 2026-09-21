// Executores de "Quem já vestiu": registrar_foto_com_a_peca (a foto do turno
// vira linha + evento na mesma transação; a fila faz o cartão e a pergunta de
// consentimento) e retirar_minha_foto (retira todas as fotos do telefone).
import { and, desc, eq, inArray } from "drizzle-orm";

import type { BotToolInputs } from "@/core/bot/tools";
import { lookCardTitle, lookDisplayName } from "@/core/looks/consent";
import { couponExpiryAfterDays } from "@/core/coupons/expiry";
import { distancesToProductPhotos, lookCouponDedupeKey, lookCouponEligibility, lookCouponToolHint, looksLikeCatalogPhoto } from "@/core/looks/coupon";
import { customerLooks, customers, orderItems, orders, productImages, productVariants } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveProductDetail } from "@/services/bot/catalog";
import { issueCoupon } from "@/services/coupons";
import { isCustomerLooksEnabled, registerCustomerLook, revokeCustomerLooksByPhone } from "@/services/customer-looks";
import { imagePhash } from "@/services/image-fingerprint";
import { loadLookCouponSettings } from "@/services/look-coupons";

import { DRY_RUN_TEXT, resolveConversationCustomerId, type BotExecutorContext, type ToolResult } from "./shared";

export async function execRegistrarFotoComAPeca(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["registrar_foto_com_a_peca"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  if (!(await isCustomerLooksEnabled(db))) {
    return { ok: false, text: "O 'Quem já vestiu' está desligado: só elogie a foto, sem prometer cartão nem página." };
  }
  const photos = ctx.recentImages ?? [];
  if (photos.length === 0) {
    return { ok: false, text: "Não há foto recente dela que eu consiga ver. Se ela quiser aparecer, peça a foto usando a peça — e chame de novo quando chegar." };
  }
  if (input.foto !== undefined && input.foto > photos.length) {
    return { ok: false, text: `Ela mandou ${photos.length === 1 ? "1 foto" : `${photos.length} fotos`} recentes: passe foto entre 1 e ${photos.length}.` };
  }
  const photo = input.foto !== undefined ? photos[input.foto - 1] : photos[photos.length - 1];
  const resolved = await resolveProductDetail(db, input.produto, { customerId: ctx.customerId });
  if (resolved.kind !== "found") {
    return {
      ok: false,
      text:
        resolved.kind === "ambiguous"
          ? `Mais de uma peça com esse nome (${resolved.candidates.map((c) => c.name).join(", ")}): passe o slug exato.`
          : `Não achei a peça "${input.produto}" no catálogo. Confira o nome com detalhar_produto ou listar_produtos.`,
    };
  }
  // Print/foto do catálogo da própria peça não é "ela com a peça": nem cartão,
  // nem pergunta, nem mimo — a Lia trata como foto de catálogo.
  const catalogDistances = await distancesToPieceLook(db, resolved.detail.id, photo);
  if (looksLikeCatalogPhoto(catalogDistances)) {
    return {
      ok: false,
      text: "Essa foto parece ser do catálogo (print ou foto da loja), não dela usando a peça: não registrei. Responda sobre a peça com detalhar_produto; se ela quiser aparecer, peça uma foto dela mesma vestindo.",
    };
  }
  const customerId = await resolveConversationCustomerId(db, ctx);
  const [customer] = customerId
    ? await db.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, customerId)).limit(1)
    : [];
  // O pedido entregue com a peça, quando existe: rastro para a dona (a foto
  // vale sem ele — ela pode ter comprado na mão).
  let orderId: string | null = null;
  let productVariantId: string | null = null;
  let deliveredOrderId: string | null = null;
  if (customerId) {
    const items = await db
      .select({ orderId: orders.id, productVariantId: orderItems.productVariantId, status: orders.status })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
      .where(and(eq(orders.customerId, customerId), eq(productVariants.productId, resolved.detail.id), inArray(orders.status, ["delivered", "shipped", "paid", "preparing"])))
      .orderBy(desc(orders.createdAt));
    const latest = items[0];
    if (latest) {
      orderId = latest.orderId;
      productVariantId = latest.productVariantId;
    }
    // O mimo exige pedido ENTREGUE — o mais recente entregue, mesmo com outro em andamento.
    deliveredOrderId = items.find((item) => item.status === "delivered")?.orderId ?? null;
  }
  const displayName = lookDisplayName(customer?.fullName);
  const registered = await registerCustomerLook(db, {
    customerId,
    phoneE164: ctx.phoneE164,
    productId: resolved.detail.id,
    productVariantId,
    orderId,
    displayName,
    photoWaMessageId: photo.waMessageId,
    now: ctx.now ?? new Date(),
  });
  if (!registered.created) {
    return { ok: true, text: "Essa foto já estava guardada: o cartão e a pergunta já foram (ou estão a caminho). Não registre de novo; se ela quiser outra peça no cartão, peça uma foto nova." };
  }
  const gift = await lookCouponFor(db, ctx, {
    lookId: registered.lookId,
    customerId,
    productId: resolved.detail.id,
    productName: resolved.detail.name,
    deliveredOrderId,
    catalogDistances,
  });
  const more = photos.length > 1 ? ` (registrei a ${input.foto ?? photos.length}ª das ${photos.length} fotos recentes)` : "";
  return {
    ok: true,
    text: `Foto guardada${more}. Em instantes ela recebe o cartão "${lookCardTitle(displayName, resolved.detail.name)}" e a pergunta se pode aparecer na página da peça — diga só que o cartão está chegando; NÃO pergunte sobre a página (a lista faz isso) e não peça outra foto.${orderId ? "" : " Não achei pedido dela com essa peça: a equipe confere antes de publicar."}${gift ? ` ${gift}` : ""}`,
  };
}

/**
 * Distâncias da foto dela às fotos DESTA peça (publicadas ou não). O hash vem
 * do turno; faltando, é calculado da própria imagem; sem imagem, null.
 */
async function distancesToPieceLook(db: DbOrTx, productId: string, photo: { phash?: string | null; image?: { base64: string } }): Promise<number[] | null> {
  let phash = photo.phash ?? null;
  if (!phash && photo.image) phash = await imagePhash(Buffer.from(photo.image.base64, "base64"));
  if (!phash) return null;
  const rows = await db.select({ phash: productImages.phash }).from(productImages).where(eq(productImages.productId, productId));
  return distancesToProductPhotos(phash, rows.map((row) => row.phash));
}

/**
 * O mimo pela foto: cupom pessoal, uma vez por peça, só com pedido ENTREGUE
 * (o print já foi barrado antes). Devolve a dica para a Lia (ou null = silêncio).
 */
async function lookCouponFor(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: { lookId: string; customerId: string | null; productId: string; productName: string; deliveredOrderId: string | null; catalogDistances: number[] | null },
): Promise<string | null> {
  const settings = await loadLookCouponSettings(db);
  const eligibility = lookCouponEligibility({
    enabled: settings.enabled,
    customerId: input.customerId,
    deliveredOrderId: input.deliveredOrderId,
    catalogDistances: input.catalogDistances,
  });
  if (!eligibility.ok) return null;
  const customerId = input.customerId as string;
  const now = ctx.now ?? new Date();
  const issued = await issueCoupon(db, {
    dedupeKey: lookCouponDedupeKey(customerId, input.productId),
    customerId,
    origin: "look_photo",
    type: "percent",
    value: settings.percent,
    expiresAt: couponExpiryAfterDays(now, settings.days),
    note: `Foto dela com ${input.productName}`,
    orderId: input.deliveredOrderId,
    now,
  });
  await db.update(customerLooks).set({ couponId: issued.couponId, updatedAt: now }).where(eq(customerLooks.id, input.lookId));
  return lookCouponToolHint({ code: issued.code, percent: settings.percent, expiresAt: issued.expiresAt, created: issued.created });
}

export async function execRetirarMinhaFoto(db: DbOrTx, ctx: BotExecutorContext): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const customerId = await resolveConversationCustomerId(db, ctx);
  const { revoked, wasPublic } = await revokeCustomerLooksByPhone(db, { phoneE164: ctx.phoneE164, customerId, source: "lia", now: ctx.now ?? new Date() });
  if (revoked === 0) return { ok: true, text: "Não havia foto dela guardada nem na página. Confirme que não há nada publicado." };
  if (wasPublic === 0) return { ok: true, text: "Nenhuma foto dela estava na página; as que estavam guardadas foram retiradas. Confirme em 1 frase, sem pedir motivo." };
  return { ok: true, text: `${wasPublic === 1 ? "A foto dela saiu" : `${wasPublic} fotos dela saíram`} da página agora. Confirme em 1 frase, sem pedir motivo.` };
}
