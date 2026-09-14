// Executor de enviar_nota_da_curadora: a nota em áudio da peça vai para a
// cliente como mensagem de voz — um anexo do turno (sai DEPOIS do texto, com
// dedupe por índice em deliverBotTurn; falha é melhor esforço). "Já foi
// enviado" é decidido pelo que de fato saiu (linha de wa_messages sent),
// não por marcador no caderninho: áudio recusado pelo provedor pode sair de
// novo, áudio aprovado no copiloto conta, sugestão descartada não conta.
import { and, eq, inArray } from "drizzle-orm";

import type { BotToolInputs } from "@/core/bot/tools";
import { waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { isBotAudioNotesEnabled } from "@/services/curator-notes";
import { publicFileUrl } from "@/services/store-catalog";

import { resolveProductDetail } from "./catalog";
import type { BotExecutorContext, ToolResult } from "./shared";

/** Mesma voz por conversa: a primeira vez + um "manda de novo". */
export const CURATOR_AUDIO_MAX_SENDS = 2;

/** O que fica na conversa do painel no lugar da transcrição. */
export function curatorAudioBody(productName: string): string {
  return `🎤 Nota da curadora sobre ${productName}`;
}

/** Quantas vezes este áudio já SAIU nesta conversa (falha não conta). */
async function countAudioSent(db: DbOrTx, conversationId: string, audioUrl: string): Promise<number> {
  const rows = await db
    .select({ id: waMessages.id })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.conversationId, conversationId),
        eq(waMessages.direction, "outbound"),
        eq(waMessages.kind, "audio"),
        eq(waMessages.mediaUrl, audioUrl),
        inArray(waMessages.status, ["sent", "delivered", "read"]),
      ),
    );
  return rows.length;
}

export async function execEnviarNotaDaCuradora(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["enviar_nota_da_curadora"],
): Promise<ToolResult> {
  const resolved = await resolveProductDetail(db, input.produto, { customerId: ctx.customerId });
  if (resolved.kind !== "found") {
    return {
      ok: false,
      text:
        resolved.kind === "ambiguous"
          ? `Mais de uma peça com esse nome (${resolved.candidates.map((c) => c.name).join(", ")}): passe o slug exato.`
          : `Não achei a peça "${input.produto}". Confira com detalhar_produto ou listar_produtos.`,
    };
  }
  const { detail } = resolved;
  const writtenFallback = detail.curatorNote ? "Responda com a nota escrita (cite as palavras dela)." : "Fique no que a descrição e a ficha dizem; se nada disser, confere com a equipe.";
  if (!detail.curatorAudioPath) {
    return { ok: false, text: `${detail.name} não tem nota em áudio da curadora. ${writtenFallback}` };
  }
  if (!(await isBotAudioNotesEnabled(db))) {
    return { ok: false, text: `O envio de áudio da curadora está desligado na Central. ${writtenFallback} Não prometa o áudio.` };
  }
  if (!ctx.onAttachment) {
    return { ok: false, text: `Não consigo mandar áudio nesta conversa agora. ${writtenFallback}` };
  }
  let audioUrl: string;
  try {
    audioUrl = publicFileUrl(detail.curatorAudioPath);
  } catch (error) {
    console.warn("[wa-bot] Não consegui montar a URL do áudio da curadora.", error);
    return { ok: false, text: `Não consigo montar o link do áudio agora. ${writtenFallback} Não prometa o áudio.` };
  }
  // Uma vez por turno, mesmo que o modelo chame de novo antes de responder.
  if (ctx.turnAudioUrls?.has(audioUrl)) {
    return { ok: true, text: `O áudio da curadora sobre ${detail.name} já vai nesta resposta — não mandei de novo.` };
  }
  const sentBefore = await countAudioSent(db, ctx.conversationId, audioUrl);
  if (sentBefore >= CURATOR_AUDIO_MAX_SENDS) {
    return {
      ok: true,
      text: `O áudio da curadora sobre ${detail.name} já foi ${sentBefore} vezes nesta conversa — não mandei de novo. Diga que ela pode ouvir nas mensagens de voz acima${detail.publicNow ? " ou na página da peça" : ""}.`,
    };
  }
  if (sentBefore > 0 && !input.reenviar) {
    return {
      ok: true,
      text: `O áudio da curadora sobre ${detail.name} já foi enviado nesta conversa — não mandei de novo. Diga que ela pode ouvir na mensagem de voz acima; se ela pedir de novo, chame com reenviar: true.`,
    };
  }
  ctx.onAttachment({ kind: "audio", audioUrl, body: curatorAudioBody(detail.name) });
  ctx.turnAudioUrls?.add(audioUrl);
  return {
    ok: true,
    text: `[Áudio enviado: a nota da curadora sobre ${detail.name} sai como mensagem de voz logo depois da sua resposta.] Apresente em 1 frase ("a curadora gravou uma nota sobre ela — segue a voz dela") e não transcreva, cite nem resuma a nota: a voz responde.`,
  };
}
