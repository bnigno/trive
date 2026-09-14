// Executor de enviar_nota_da_curadora: a nota em áudio da peça vai para a
// cliente como mensagem de voz — um anexo do turno (sai ANTES do texto, com
// dedupe por índice em deliverBotTurn). Uma vez por peça na conversa, salvo
// quando ela pede de novo; com o interruptor desligado, a ferramenta diz e
// a Lia fica na nota escrita.
import { markCuratorNoteSent, wasCuratorNoteSent } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import type { DbOrTx } from "@/queue/enqueue";
import { isBotAudioNotesEnabled } from "@/services/curator-notes";
import { publicFileUrl } from "@/services/store-catalog";

import { resolveProductDetail } from "./catalog";
import { readBotState, updateBotState, type BotExecutorContext, type ToolResult } from "./shared";

/** O que fica na conversa do painel no lugar da transcrição. */
export function curatorAudioBody(productName: string): string {
  return `🎤 Nota da curadora sobre ${productName}`;
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
  if (!detail.curatorAudioPath) {
    return {
      ok: false,
      text: `${detail.name} não tem nota em áudio da curadora. ${detail.curatorNote ? "Responda com a nota escrita (cite as palavras dela)." : "Fique no que a descrição e a ficha dizem; se nada disser, confere com a equipe."}`,
    };
  }
  if (!(await isBotAudioNotesEnabled(db))) {
    return {
      ok: false,
      text: `O envio de áudio da curadora está desligado na Central. ${detail.curatorNote ? "Responda com a nota escrita (cite as palavras dela)." : "Fique no que a descrição e a ficha dizem."} Não prometa o áudio.`,
    };
  }
  if (!ctx.onAttachment) {
    return { ok: false, text: "Não consigo mandar áudio nesta conversa agora. Responda com a nota escrita, se houver." };
  }
  const state = await readBotState(db, ctx);
  if (wasCuratorNoteSent(state, detail.slug) && !input.reenviar) {
    return {
      ok: true,
      text: `O áudio da curadora sobre ${detail.name} já foi enviado nesta conversa — não mandei de novo. Diga que ela pode ouvir na mensagem de voz acima; se ela pedir de novo, chame com reenviar: true.`,
    };
  }
  ctx.onAttachment({
    kind: "audio",
    audioUrl: publicFileUrl(detail.curatorAudioPath),
    body: curatorAudioBody(detail.name),
  });
  // Em copiloto a dona decide cada envio (a sugestão pode ser descartada):
  // sem marcador, senão a Lia diria "já enviei" de um áudio que nunca saiu.
  if (!ctx.copilot) {
    await updateBotState(db, ctx, (current) => markCuratorNoteSent(current, detail.slug));
  }
  return {
    ok: true,
    text: `[Áudio enviado: a nota da curadora sobre ${detail.name} sai como mensagem de voz junto com a sua resposta.] Apresente em 1 frase ("a curadora gravou uma nota sobre ela — ouve aqui") e não transcreva nem resuma o áudio.`,
  };
}
