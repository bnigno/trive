// Executores de "Me vê com ela": oferecer_previa (a pergunta tocável que já
// pede o consentimento) e vestir_em_mim (a foto DELA, depois do toque, vai
// para a fila). Dentro da transação do turno: nada de kick aqui — o
// runBotTurn dá o kick depois do commit.
import type { BotToolInputs } from "@/core/bot/tools";
import { colorOfVariant } from "@/core/bot/variants";
import { offerRefusalText, TRYON_OFFER_BUTTON, TRYON_OFFER_TITLE, tryOnOfferBody, tryOnOfferOptions } from "@/core/tryon/offer";
import { failureText, quotaText, requiredFraming } from "@/core/tryon/rules";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveProductDetail } from "@/services/bot/catalog";
import { queueTryOn } from "@/services/tryon";
import { createTryOnOffer, evaluateTryOnOffer, findTryOnForPhoto } from "@/services/tryon-offer";
import { loadTryOnSettings } from "@/services/tryon-settings";

import { DRY_RUN_TEXT, resolveConversationCustomerId, type BotExecutorContext, type ToolResult } from "./shared";

type Picked = { waMessageId: string } | { error: string } | null;

/** A foto recente pedida (foto = n) ou a última; null = não há foto recente que a Lia enxergue. */
function pickPhoto(ctx: BotExecutorContext, foto: number | undefined): Picked {
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
  // Turno por conta própria (retorno combinado, sacola parada): não é ela escolhendo a peça agora.
  if (ctx.proactive && input.ela_pediu !== true) return { ok: false, text: "Na sua mensagem de retomada não ofereça a prévia: espere ela escolher a peça ou pedir." };
  if (!ctx.onAttachment) return { ok: false, text: "Aqui não dá para mandar a pergunta tocável da prévia: não ofereça." };
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
  const ofColor = color ? detail.variants.filter((variant) => colorOfVariant(variant.attributes, detail.attributesSchema)?.toLowerCase() === color.toLowerCase()) : [];
  const now = ctx.now ?? new Date();
  const { verdict, category } = await evaluateTryOnOffer(db, {
    conversationId: ctx.conversationId,
    phoneE164: ctx.phoneE164,
    productId: detail.id,
    color,
    inStock: detail.variants.some((variant) => variant.availableQty > 0),
    // Cor que a peça não tem, ou sem estoque nela: a prévia não sai nessa cor.
    colorInStock: color === null || ofColor.some((variant) => variant.availableQty > 0),
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
  ctx.onAttachment({
    kind: "option_list",
    message: tryOnOfferBody(detail.name, photoWaMessageId !== null, category ? requiredFraming(category) : null),
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
  switch (target.kind) {
    case "in_flight":
      return { ok: false, text: `A prévia de ${target.productName} já está sendo feita e chega sozinha: não chame de novo.` };
    case "pending_tap":
      return {
        ok: false,
        text: `Ela ainda não tocou em "Quero me ver" na pergunta da prévia de ${target.productName}: lembre-a, em 1 frase, de tocar no botão (a foto só vai para a IA com esse toque). Não chame oferecer_previa de novo.`,
      };
    case "ask_again":
      return {
        ok: false,
        text: `A foto anterior não serviu para a prévia de ${target.productName}: cada foto tem o seu toque — chame oferecer_previa com com_a_foto_dela e ela_pediu (ela toca de novo em "Quero me ver").`,
      };
    case "none":
      return {
        ok: false,
        text: "Não há prévia aceita esperando foto (sem o toque dela em 'Quero me ver', ou faz mais de 2 h, ou ela disse 'Agora não'). Se ELA quer se ver com a peça, chame oferecer_previa com ela_pediu e com_a_foto_dela.",
      };
  }
  const picked = pickPhoto(ctx, input.foto);
  if (!picked) return { ok: false, text: "Não há foto recente dela que eu consiga ver: espere a foto dela chegar (ela já sabe que precisa mandar)." };
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
      case "foto_antiga":
        return { ok: false, text: "Essa foto é de antes da pergunta da prévia (ou já foi usada): espere a foto NOVA dela." };
      default:
        return { ok: false, text: `Não deu para pôr a prévia na fila agora: diga algo como "${failureText("indisponivel")}"` };
    }
  }
  return {
    ok: true,
    text: `A prévia de ${target.productName} está sendo feita com essa foto e chega sozinha em 1–2 minutos. Diga em 1 frase que está vestindo (ex.: "tô te vestindo, em um minutinho te mando 🪄"). Não comente o corpo dela e não prometa caimento nem tamanho.`,
  };
}
