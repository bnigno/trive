// Executores de "Me vê com ela": oferecer_previa (a pergunta tocável que já
// pede o consentimento) e vestir_em_mim (a foto DELA, depois do toque, vai
// para a fila). Dentro da transação do turno: nada de kick aqui — o
// runBotTurn dá o kick depois do commit.
import type { BotToolInputs } from "@/core/bot/tools";
import { offerRefusalText, TRYON_OFFER_BUTTON, TRYON_OFFER_TITLE, tryOnOfferBody, tryOnOfferOptions } from "@/core/tryon/offer";
import { failureText, quotaText } from "@/core/tryon/rules";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveProductDetail } from "@/services/bot/catalog";
import { colorOfVariant } from "@/core/bot/variants";
import { queueTryOn } from "@/services/tryon";
import { createTryOnOffer, evaluateTryOnOffer, findTryOnForPhoto } from "@/services/tryon-offer";
import { loadTryOnSettings } from "@/services/tryon-settings";

import { DRY_RUN_TEXT, resolveConversationCustomerId, type BotExecutorContext, type ToolResult } from "./shared";

function pickPhoto(ctx: BotExecutorContext, foto: number | undefined): { waMessageId: string } | { error: string } | null {
  const photos = ctx.recentImages ?? [];
  if (photos.length === 0) return null;
  if (foto !== undefined && foto > photos.length) {
    return { error: `Ela mandou ${photos.length === 1 ? "1 foto" : `${photos.length} fotos`} recentes: passe foto entre 1 e ${photos.length}.` };
  }
  const photo = foto !== undefined ? photos[foto - 1] : photos[photos.length - 1];
  return photo ? { waMessageId: photo.waMessageId } : null;
}

export async function execOferecerPrevia(db: DbOrTx, ctx: BotExecutorContext, input: BotToolInputs["oferecer_previa"]): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const resolved = await resolveProductDetail(db, input.produto, { customerId: ctx.customerId });
  if (resolved.kind !== "found") {
    return {
      ok: false,
      text:
        resolved.kind === "ambiguous"
          ? `Mais de uma peça com esse nome (${resolved.candidates.map((c) => c.name).join(", ")}): passe o slug exato.`
          : `Não achei a peça "${input.produto}" no catálogo. Confira com detalhar_produto.`,
    };
  }
  const { detail } = resolved;
  const color = input.cor?.trim() || null;
  const ofColor = color ? detail.variants.filter((variant) => colorOfVariant(variant.attributes, detail.attributesSchema)?.toLowerCase() === color.toLowerCase()) : detail.variants;
  const inStock = (ofColor.length > 0 ? ofColor : detail.variants).some((variant) => variant.availableQty > 0);
  const now = ctx.now ?? new Date();
  const { verdict } = await evaluateTryOnOffer(db, {
    conversationId: ctx.conversationId,
    phoneE164: ctx.phoneE164,
    productId: detail.id,
    inStock,
    asked: input.ela_pediu === true,
    now,
  });
  if (!verdict.offer) return { ok: false, text: offerRefusalText(verdict.reason) };

  let photoWaMessageId: string | null = null;
  if (input.foto !== undefined || input.com_a_foto_dela === true) {
    const picked = pickPhoto(ctx, input.foto);
    if (picked && "error" in picked) return { ok: false, text: picked.error };
    photoWaMessageId = picked?.waMessageId ?? null;
  }
  const customerId = await resolveConversationCustomerId(db, ctx);
  const requestId = await createTryOnOffer(db, {
    conversationId: ctx.conversationId,
    customerId,
    phoneE164: ctx.phoneE164,
    productId: detail.id,
    color,
    photoWaMessageId,
    now,
  });
  ctx.onAttachment?.({
    kind: "option_list",
    message: tryOnOfferBody(detail.name, photoWaMessageId !== null),
    title: TRYON_OFFER_TITLE,
    buttonLabel: TRYON_OFFER_BUTTON,
    options: tryOnOfferOptions(requestId),
  });
  return {
    ok: true,
    text: `A pergunta tocável "Quer se ver com ela?" foi enviada (Quero me ver / Agora não) — ela já explica que é prévia feita com IA e o que acontece com a foto. Escreva no máximo 1 frase curta antes; NÃO repita a oferta, não peça a foto agora (o toque dela pede) e não insista.`,
  };
}

export async function execVestirEmMim(db: DbOrTx, ctx: BotExecutorContext, input: BotToolInputs["vestir_em_mim"]): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const settings = await loadTryOnSettings(db);
  if (!settings.enabled) return { ok: false, text: "A prévia na foto está desligada na loja: não prometa a prévia; siga com a peça." };
  const now = ctx.now ?? new Date();
  const target = await findTryOnForPhoto(db, { conversationId: ctx.conversationId, now });
  if (target.kind === "in_flight") return { ok: false, text: `A prévia de ${target.productName} já está sendo feita e chega sozinha: não chame de novo.` };
  if (target.kind === "none") {
    return {
      ok: false,
      text: "Ela ainda não tocou em 'Quero me ver' (ou faz mais de 2 h): a foto dela só vai para a IA com esse toque. Se fizer sentido, chame oferecer_previa (com com_a_foto_dela, se a foto já está aqui).",
    };
  }
  const picked = pickPhoto(ctx, input.foto);
  if (!picked) return { ok: false, text: "Não há foto recente dela que eu consiga ver: espere a foto dela chegar (ela já recebeu o pedido de foto)." };
  if ("error" in picked) return { ok: false, text: picked.error };
  const queued = await queueTryOn(db, { requestId: target.request.id, photoWaMessageId: picked.waMessageId, now, kick: false });
  if (!queued.ok) {
    switch (queued.reason) {
      case "limite_cliente":
      case "limite_loja":
      case "limite_fotos":
        return { ok: false, text: `Teto do dia: diga a ela, com as suas palavras, algo como "${quotaText(queued.reason, settings.perCustomerDaily)}"` };
      case "em_andamento":
        return { ok: false, text: "Já tem uma prévia dela sendo feita: ela chega sozinha. Não chame de novo." };
      case "desligado":
        return { ok: false, text: "A prévia na foto está desligada na loja: não prometa a prévia; siga com a peça." };
      default:
        return { ok: false, text: `Não deu para pôr a prévia na fila agora: diga algo como "${failureText("indisponivel")}"` };
    }
  }
  return {
    ok: true,
    text: `A prévia de ${target.productName} está sendo feita com essa foto e chega sozinha em 1–2 minutos. Diga em 1 frase que está vestindo (ex.: "tô te vestindo, em um minutinho te mando 🪄"). Não comente o corpo dela e não prometa caimento nem tamanho.`,
  };
}
