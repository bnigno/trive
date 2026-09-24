// Executor de "Me ajuda a escolher?": a cliente em dúvida entre 2 ou 3 peças
// ganha uma votação para as amigas. A rodada nasce nesta conversa (o placar
// volta por ela), dentro da transação do turno — o retry do turno reencontra
// a mesma rodada pela mensagem que pediu. O cartão "Qual fica melhor?" vai
// pelo mesmo caminho dos cartões da vitrine.
import { pickImagePath } from "@/core/bot/variants";
import type { BotToolInputs } from "@/core/bot/tools";
import { normalizeDisplayName, optionLabel } from "@/core/friends/decision";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveProductDetail } from "@/services/bot/catalog";
import { createDecisionRound, FriendRoundError, isFriendsVoteEnabled } from "@/services/friend-rounds";

import { DRY_RUN_TEXT, type ExecutorCtx, type ToolResult } from "./shared";

export async function execPedirOpiniaoDasAmigas(
  db: DbOrTx,
  ctx: ExecutorCtx,
  input: BotToolInputs["pedir_opiniao_das_amigas"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  if (!(await isFriendsVoteEnabled(db))) {
    return { ok: false, text: "A votação das amigas está desligada na loja: não ofereça de novo nesta conversa; ajude ela a escolher você mesma." };
  }
  const displayName = normalizeDisplayName(input.nome);
  if (!displayName) return { ok: false, text: "Pergunte o primeiro nome dela para as amigas verem (\"Qual fica melhor na Ana?\") e chame de novo." };

  const viewer = { customerId: ctx.customerId };
  const options = [];
  for (const [index, term] of input.pecas.entries()) {
    const resolved = await resolveProductDetail(db, term, viewer);
    if (resolved.kind === "none") {
      return { ok: false, text: `Não encontrei a peça "${term}". Use o nome exato ou o slug de listar_produtos.` };
    }
    if (resolved.kind === "ambiguous") {
      return {
        ok: false,
        text: `"${term}" bate com ${resolved.candidates.length} peças — chame de novo com o slug exato: ${resolved.candidates
          .slice(0, 6)
          .map((item) => `${item.name} (${item.slug})`)
          .join("; ")}.`,
      };
    }
    const detail = input.detalhes?.[index]?.trim() || null;
    options.push({
      productId: resolved.detail.id,
      name: resolved.detail.name,
      detail,
      slug: resolved.detail.slug,
      imagePath: pickImagePath(resolved.detail.images, detail),
    });
  }

  let round;
  try {
    round = await createDecisionRound(db, {
      conversationId: ctx.conversationId,
      createKey: `turn:${ctx.lastInboundId}`,
      displayName,
      options,
      now: ctx.now ?? new Date(),
    });
  } catch (error) {
    if (error instanceof FriendRoundError) return { ok: false, text: `${error.message} Ajuste e chame de novo.` };
    throw error;
  }

  const labels = options.map((option, index) => optionLabel(index, option.name, option.detail));
  const withPhoto = options.flatMap((option, index) =>
    option.imagePath ? [{ slug: option.slug, name: `${labels[index].letter} · ${labels[index].name}`, priceLabel: "", imagePath: option.imagePath }] : [],
  );
  const card =
    withPhoto.length === options.length
      ? await ctx.emitCard({
          kind: "catalog",
          eyebrow: "ME AJUDA A ESCOLHER?",
          title: `Qual fica melhor na ${displayName}?`,
          items: withPhoto,
          caption: `Qual fica melhor na ${displayName}? Vota aqui: ${round.url}`,
        })
      : false;

  return {
    ok: true,
    text: [
      `Votação criada (${labels.map((label) => `${label.letter}: ${label.name}`).join(" · ")}). Link: ${round.url}`,
      card ? "O cartão \"Qual fica melhor?\" com o link vai junto: diga a ela para encaminhar às amigas." : "Mande o link e diga a ela para encaminhar às amigas.",
      "Diga que o placar chega aqui 10 min depois do primeiro voto e o resultado em 24 h. Nada fica reservado durante a votação.",
    ].join("\n"),
  };
}
