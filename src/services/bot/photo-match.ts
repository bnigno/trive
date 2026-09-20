// Ferramenta identificar_peca_na_foto: a Lia pergunta "qual peça do catálogo
// é esta foto?". Primeiro a impressão digital (grátis, exata); se não bater,
// a comparação visual com candidatas — só para a foto deste turno e só se
// sobrar tempo. Grava em media_meta da foto o que reconheceu (nunca a foto).
import { eq, sql } from "drizzle-orm";

import {
  describePhotoMatches,
  PHOTO_MATCH_BUDGET_MS,
  PHOTO_MATCH_MIN_BUDGET_MS,
  type PhotoMatchOutcome,
  type VisionSkipReason,
} from "@/core/bot/photo-match";
import type { BotToolInputs } from "@/core/bot/tools";
import { waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { findProductsByPhotoHash, isBotPhotoMatchEnabled, matchPhotoWithVision } from "@/services/photo-match";

import type { BotExecutorContext, ToolResult } from "./shared";

export async function execIdentificarPecaNaFoto(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["identificar_peca_na_foto"],
): Promise<ToolResult> {
  if (!(await isBotPhotoMatchEnabled(db))) {
    return { ok: false, text: "O reconhecimento de peça por foto está desligado: siga o fluxo de fotos parecidas (diga o que viu e busque com listar_produtos, categoria + cor)." };
  }
  const photos = ctx.recentImages ?? [];
  if (photos.length === 0) {
    return { ok: false, text: "Não há foto recente dela que eu consiga ver. Peça para ela mandar (ou reenviar) a foto e chame de novo quando chegar." };
  }
  if (input.foto !== undefined && input.foto > photos.length) {
    return { ok: false, text: `Ela mandou ${photos.length === 1 ? "1 foto" : `${photos.length} fotos`} recentes: passe foto entre 1 e ${photos.length}.` };
  }
  const photo = input.foto !== undefined ? photos[input.foto - 1] : photos[photos.length - 1];
  const now = ctx.now ?? new Date();

  const outcome: PhotoMatchOutcome = { exact: [], maybe: [], provaveis: [], talvez: [], visionSkipped: null };

  // Camada 1: a mesma foto do catálogo (ou quase).
  if (photo.phash) {
    const ranked = await findProductsByPhotoHash(db, photo.phash);
    outcome.exact = ranked.filter((match) => match.tier === "exact");
    outcome.maybe = ranked.filter((match) => match.tier === "maybe");
  }

  // Camada 2: só sem acerto exato, com os bytes da foto (turno atual), com as
  // dependências do turno e com tempo sobrando para o modelo ainda responder.
  if (outcome.exact.length === 0) {
    const skip = visionSkipReason(ctx, photo.image, now);
    if (skip) {
      outcome.visionSkipped = skip;
    } else {
      const remainingMs = ctx.photoMatch!.deadlineAt.getTime() - now.getTime() - PHOTO_MATCH_MIN_BUDGET_MS;
      const vision = await matchPhotoWithVision(
        db,
        { assistant: ctx.photoMatch!.assistant, storage: ctx.photoMatch!.storage },
        { image: photo.image!, filters: { categoria: input.categoria, cor: input.cor, busca: input.busca }, customerId: ctx.customerId, budgetMs: Math.min(PHOTO_MATCH_BUDGET_MS, remainingMs) },
      );
      outcome.provaveis = vision.provaveis;
      outcome.talvez = vision.talvez;
      if (vision.failed && vision.failed !== "sem_candidatas") outcome.visionSkipped = "falhou";
    }
  }

  if (!ctx.dryRun) await recordRecognition(db, photo.waMessageId, outcome);
  return describePhotoMatches(outcome);
}

function visionSkipReason(ctx: BotExecutorContext, image: { base64: string } | undefined, now: Date): VisionSkipReason | null {
  if (!ctx.photoMatch) return "sem_deps";
  if (!image) return "sem_bytes";
  if (ctx.photoMatch.deadlineAt.getTime() - now.getTime() < PHOTO_MATCH_MIN_BUDGET_MS * 2) return "sem_tempo";
  return null;
}

/** O que a Lia reconheceu fica em media_meta.reconhecido da foto (merge jsonb: não apaga o resto); a foto em si nunca é guardada. */
async function recordRecognition(db: DbOrTx, waMessageId: string, outcome: PhotoMatchOutcome): Promise<void> {
  const byHash = outcome.exact.length > 0 ? outcome.exact : outcome.maybe;
  const byVision = [...outcome.provaveis, ...outcome.talvez];
  const chosen: { slug: string; name: string }[] = byHash.length > 0 ? byHash : byVision;
  if (chosen.length === 0) return;
  const reconhecido = {
    slugs: chosen.map((piece) => piece.slug),
    nomes: chosen.map((piece) => piece.name),
    camada: byHash.length > 0 ? "hash" : "visao",
    ...(byHash.length > 0 ? { distancia: byHash[0].distance } : { confianca: byVision[0].confidence }),
  };
  await db
    .update(waMessages)
    .set({ mediaMeta: sql`coalesce(${waMessages.mediaMeta}, '{}'::jsonb) || ${JSON.stringify({ reconhecido })}::jsonb` })
    .where(eq(waMessages.id, waMessageId));
}
