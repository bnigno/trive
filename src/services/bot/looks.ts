// Executores de "Quem já vestiu": registrar_foto_com_a_peca (a foto do turno
// vira linha + evento na mesma transação; a fila faz o cartão e a pergunta de
// consentimento) e retirar_minha_foto (retira todas as fotos do telefone).
import { and, desc, eq, inArray } from "drizzle-orm";

import type { BotToolInputs } from "@/core/bot/tools";
import { lookCardTitle, lookDisplayName } from "@/core/looks/consent";
import { customers, orderItems, orders, productVariants } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveProductDetail } from "@/services/bot/catalog";
import { isCustomerLooksEnabled, registerCustomerLook, revokeCustomerLooksByPhone } from "@/services/customer-looks";

import { resolveConversationCustomerId } from "./orders";
import { DRY_RUN_TEXT, type BotExecutorContext, type ToolResult } from "./shared";

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
  const customerId = await resolveConversationCustomerId(db, ctx);
  const [customer] = customerId
    ? await db.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, customerId)).limit(1)
    : [];
  // O pedido entregue com a peça, quando existe: rastro para a dona (a foto
  // vale sem ele — ela pode ter comprado na mão).
  let orderId: string | null = null;
  let productVariantId: string | null = null;
  if (customerId) {
    const [item] = await db
      .select({ orderId: orders.id, productVariantId: orderItems.productVariantId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
      .where(and(eq(orders.customerId, customerId), eq(productVariants.productId, resolved.detail.id), inArray(orders.status, ["delivered", "shipped", "paid", "preparing"])))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    if (item) {
      orderId = item.orderId;
      productVariantId = item.productVariantId;
    }
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
  const more = photos.length > 1 ? ` (registrei a ${input.foto ?? photos.length}ª das ${photos.length} fotos recentes)` : "";
  return {
    ok: true,
    text: `Foto guardada${more}. Em instantes ela recebe o cartão "${lookCardTitle(displayName, resolved.detail.name)}" e a pergunta se pode aparecer na página da peça — diga só que o cartão está chegando; NÃO pergunte sobre a página (a lista faz isso) e não peça outra foto.${orderId ? "" : " Não achei pedido dela com essa peça: a equipe confere antes de publicar."}`,
  };
}

export async function execRetirarMinhaFoto(db: DbOrTx, ctx: BotExecutorContext): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const customerId = await resolveConversationCustomerId(db, ctx);
  const { revoked, wasPublic } = await revokeCustomerLooksByPhone(db, { phoneE164: ctx.phoneE164, customerId, source: "lia", now: ctx.now ?? new Date() });
  if (revoked === 0) return { ok: true, text: "Não havia foto dela guardada nem na página. Confirme que não há nada publicado." };
  if (wasPublic === 0) return { ok: true, text: "Nenhuma foto dela estava na página; as que estavam guardadas foram retiradas. Confirme em 1 frase, sem pedir motivo." };
  return { ok: true, text: `${wasPublic === 1 ? "A foto dela saiu" : `${wasPublic} fotos dela saíram`} da página agora. Confirme em 1 frase, sem pedir motivo.` };
}
