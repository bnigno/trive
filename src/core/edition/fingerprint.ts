// A impressão digital dos cartões da edição — PURO. O cartão ficou velho
// quando o que ele DIRIA hoje é outro: hash do que foi desenhado, por peça,
// guardado no pedido ao gerar. Não é o updated_at da peça (sobe por gatilho
// a cada UPDATE, inclusive por uma foto nova que não entra no cartão).

import { z } from "zod";

import type { EditionCardData } from "@/core/edition/types";
import { sha256Hex } from "@/lib/hash";

/** O hash de um cartão: tudo o que entra no desenho, em ordem fixa. */
export function editionCardFingerprint(data: EditionCardData): string {
  return sha256Hex(
    JSON.stringify([
      data.editionName,
      data.productName,
      data.curatorNote,
      data.wearNote,
      data.wearSource,
      data.careNote,
      data.qrUrl,
      data.qrTarget,
      data.printedAddress,
    ]),
  );
}

/** productId → hash, como fica guardado no pedido. */
export type EditionFingerprints = Record<string, string>;

const fingerprintsSchema = z.record(z.string(), z.string());

/** O que está guardado no pedido; qualquer coisa fora do formato vale como "nada". */
export function parseEditionFingerprints(stored: unknown): EditionFingerprints | null {
  const parsed = fingerprintsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** Os hashes de hoje, para guardar ao gerar. */
export function editionFingerprintsOf(cards: { productId: string; data: EditionCardData }[]): EditionFingerprints {
  return Object.fromEntries(cards.map((card) => [card.productId, editionCardFingerprint(card.data)]));
}

/**
 * Este cartão ficou velho? Só depois de gerados (stored != null): o hash de
 * hoje é outro, ou a peça nem estava na geração anterior.
 */
export function isEditionCardStale(stored: EditionFingerprints | null, productId: string, data: EditionCardData): boolean {
  if (stored === null) return false;
  return stored[productId] !== editionCardFingerprint(data);
}
