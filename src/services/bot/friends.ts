// Executor de "Me ajuda a escolher?": a cliente em dúvida entre 2 ou 3 peças
// ganha uma votação para as amigas. A rodada nasce nesta conversa (o placar
// volta por ela), dentro da transação do turno — o retry do turno reencontra
// a mesma rodada pela mensagem que pediu. O cartão "Qual fica melhor?" vai
// pelo mesmo caminho dos cartões da vitrine.
import { pickImagePath } from "@/core/bot/variants";
import { BOT_TOOL_NAMES, type BotToolInputs, type BotToolName } from "@/core/bot/tools";
import { normalizeDisplayName, optionLabel } from "@/core/friends/decision";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveProductDetail } from "@/services/bot/catalog";
import { createDecisionRound, FriendRoundError, isFriendsVoteEnabled, roundCreateKey } from "@/services/friend-rounds";

import { DRY_RUN_TEXT, formatPriceRange, type ExecutorCtx, type ToolResult } from "./shared";

const TOOLS_WITHOUT_FRIENDS: readonly BotToolName[] = BOT_TOOL_NAMES.filter((name) => name !== "pedir_opiniao_das_amigas");

/**
 * As ferramentas do turno: com "Me ajuda a escolher?" desligado, a
 * ferramenta nem vai ao modelo (a descrição dela manda oferecer — ligada ou
 * não, a Lia ofereceria). A lista é a mesma em todos os turnos enquanto o
 * interruptor não muda, então o cache do prefixo continua valendo.
 */
export async function turnToolsFor(db: DbOrTx): Promise<readonly BotToolName[] | undefined> {
  return (await isFriendsVoteEnabled(db)) ? undefined : TOOLS_WITHOUT_FRIENDS;
}

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
    const prices = resolved.detail.variants.map((variant) => variant.priceCents);
    options.push({
      productId: resolved.detail.id,
      name: resolved.detail.name,
      detail,
      slug: resolved.detail.slug,
      imagePath: pickImagePath(resolved.detail.images, detail),
      priceLabel: prices.length > 0 ? formatPriceRange(Math.min(...prices), Math.max(...prices)) : "",
    });
  }

  let round;
  try {
    round = await createDecisionRound(db, {
      conversationId: ctx.conversationId,
      createKey: roundCreateKey(ctx.lastInboundId, options),
      displayName,
      options: options.map(({ priceLabel: _price, ...option }) => option),
      now: ctx.now ?? new Date(),
    });
  } catch (error) {
    if (error instanceof FriendRoundError) return { ok: false, text: `${error.message} Ajuste e chame de novo.` };
    throw error;
  }

  const labels = options.map((option, index) => optionLabel(index, option.name, option.detail));
  // O cartão da vitrine exige preço em cada peça (o handler do render valida):
  // sem preço ou sem foto, vai só o link.
  const withPhoto = options.flatMap((option, index) =>
    option.imagePath && option.priceLabel
      ? [{ slug: option.slug, name: `${labels[index].letter} · ${labels[index].name}`, priceLabel: option.priceLabel, imagePath: option.imagePath }]
      : [],
  );
  const card =
    withPhoto.length === options.length
      ? await ctx.emitCard({
          kind: "catalog",
          eyebrow: "ME AJUDA A ESCOLHER?",
          title: `Qual fica melhor na ${round.displayName}?`,
          items: withPhoto,
          caption: `Qual fica melhor na ${round.displayName}? Vota aqui: ${round.url}`,
        })
      : false;

  return {
    ok: true,
    text: [
      `Votação criada para "${round.displayName}" (${labels.map((label) => `${label.letter}: ${label.name}`).join(" · ")}).`,
      card
        ? `O cartão "Qual fica melhor?" já leva o link na legenda: diga a ela para ENCAMINHAR o cartão às amigas (não repita o link). Link, se ela pedir: ${round.url}`
        : `Mande este link para ela encaminhar às amigas: ${round.url}`,
      "O placar chega para ela aqui 10 min depois do primeiro voto e o resultado quando a votação fechar (mensagens só das 9h às 21h). Nada fica reservado durante a votação.",
    ].join("\n"),
  };
}
