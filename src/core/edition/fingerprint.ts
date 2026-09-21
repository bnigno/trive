// A impressão digital dos cartões da edição — PURO. O cartão ficou velho
// quando o que ele DIRIA hoje é outro: hash do que foi desenhado, por peça,
// guardado no pedido ao gerar. Não é o updated_at da peça (sobe por gatilho
// a cada UPDATE, inclusive por uma foto nova que não entra no cartão).

import { z } from "zod";

import type { DebutLetterData, EditionCardData } from "@/core/edition/types";
import { VOUCHER_FINGERPRINT_KEYS, voucherFingerprint, type VoucherCardData } from "@/core/edition/voucher";
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
      // O nome da loja só entra no desenho do presente ("Conheça a TRIVÉ…"):
      // muda o hash só desses cartões — os de peça não pedem redesenho à toa.
      ...(data.qrTarget === "home" ? [data.storeName] : []),
      data.printedAddress,
    ]),
  );
}

/** O hash da carta de estreia: o que entra no desenho dela, em ordem fixa. */
export function debutLetterFingerprint(data: DebutLetterData): string {
  return sha256Hex(JSON.stringify([data.recipientName, data.text, data.signature, data.editionName]));
}

/** A chave da carta no mapa guardado (nunca colide com um productId, que é uuid). */
export const LETTER_FINGERPRINT_KEY = "carta";

/** productId → hash (e "carta" → hash da carta), como fica guardado no pedido. */
export type EditionFingerprints = Record<string, string>;

const fingerprintsSchema = z.record(z.string(), z.string());

/** O que está guardado no pedido; qualquer coisa fora do formato vale como "nada". */
export function parseEditionFingerprints(stored: unknown): EditionFingerprints | null {
  const parsed = fingerprintsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** Os hashes de hoje, para guardar ao gerar. */
export function editionFingerprintsOf(
  cards: { productId: string; data: EditionCardData }[],
  letter: DebutLetterData | null = null,
  vouchers: readonly VoucherCardData[] = [],
): EditionFingerprints {
  const entries = cards.map((card): [string, string] => [card.productId, editionCardFingerprint(card.data)]);
  if (letter) entries.push([LETTER_FINGERPRINT_KEY, debutLetterFingerprint(letter)]);
  for (const voucher of vouchers) entries.push([VOUCHER_FINGERPRINT_KEYS[voucher.kind], voucherFingerprint(voucher)]);
  return Object.fromEntries(entries);
}

/** O vale ficou velho? Só depois de gerados: o hash de hoje é outro, ou o vale nem estava na geração. */
export function isVoucherStale(stored: EditionFingerprints | null, voucher: VoucherCardData): boolean {
  if (stored === null) return false;
  return stored[VOUCHER_FINGERPRINT_KEYS[voucher.kind]] !== voucherFingerprint(voucher);
}

/**
 * A carta ficou velha? Só depois de gerados e só quando há carta hoje: o
 * texto mudou, ou a carta foi escrita depois da geração (não existe imagem).
 */
export function isDebutLetterStale(stored: EditionFingerprints | null, letter: DebutLetterData | null): boolean {
  if (stored === null || letter === null) return false;
  return stored[LETTER_FINGERPRINT_KEY] !== debutLetterFingerprint(letter);
}

/**
 * Este cartão ficou velho? Só depois de gerados (stored != null): o hash de
 * hoje é outro, ou a peça nem estava na geração anterior.
 */
export function isEditionCardStale(stored: EditionFingerprints | null, productId: string, data: EditionCardData): boolean {
  if (stored === null) return false;
  return stored[productId] !== editionCardFingerprint(data);
}
