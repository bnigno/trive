// O vale de papel na caixa — PURO. Dois cartões de 15 × 10 cm (o tamanho da
// carta de estreia) impressos com os cartões da edição: "para você" (cupom
// pessoal da compradora) e "para uma amiga" (vale aberto, primeira compra,
// uma vez por cliente, até 3 usos; quando a amiga paga, quem indicou ganha
// o prêmio). O QR abre o WhatsApp da Lia com "Oi Lia, tenho o vale X".
import { sha256Hex } from "@/lib/hash";

export const REFERRAL_MAX_USES = 3;

export type VoucherKind = "para_voce" | "para_uma_amiga";
export const VOUCHER_KINDS: readonly VoucherKind[] = ["para_voce", "para_uma_amiga"];

/** A chave de cada vale no mapa de impressões digitais do pedido (nunca colide com um productId). */
export const VOUCHER_FINGERPRINT_KEYS: Record<VoucherKind, string> = { para_voce: "vale_voce", para_uma_amiga: "vale_amiga" };

export interface VoucherCardData {
  kind: VoucherKind;
  code: string;
  percent: number;
  /** "até 20/11" — já formatado no relógio de São Paulo. */
  expiresLabel: string;
  /** Primeiro nome da compradora (o "para você" fala com ela; o da amiga cita quem deu). */
  firstName: string;
  storeName: string;
  editionName: string | null;
  /** O que o QR abre (wa.me com a mensagem pronta). */
  qrUrl: string;
}

/**
 * Quais vales saem no pedido: nenhum sem o recurso ou sem o WhatsApp da loja
 * (o QR não teria destino); só o da amiga quando é presente (a caixa vai
 * para outra pessoa — um vale pessoal da compradora ali confundiria).
 */
export function voucherPlan(input: { enabled: boolean; isGift: boolean; hasStoreWhatsapp: boolean }): VoucherKind[] {
  if (!input.enabled || !input.hasStoreWhatsapp) return [];
  return input.isGift ? ["para_uma_amiga"] : ["para_voce", "para_uma_amiga"];
}

/** A mensagem pronta que o QR abre no WhatsApp da Lia. */
export function voucherQrText(sellerName: string, code: string): string {
  return `Oi, ${sellerName}! Tenho o vale ${code}`;
}

export interface VoucherTexts {
  eyebrow: string;
  headline: string;
  body: string;
  invite: string;
}

/** O que sai escrito em cada vale. */
export function voucherTexts(data: Pick<VoucherCardData, "kind" | "percent" | "firstName" | "storeName" | "expiresLabel">): VoucherTexts {
  if (data.kind === "para_voce") {
    return {
      eyebrow: `VALE ${data.percent}% · PARA VOCÊ`,
      headline: `${data.firstName}, este é seu`,
      body: `${data.percent}% na sua próxima peça da ${data.storeName}, ${data.expiresLabel}.`,
      invite: "Aponte a câmera e diga o código por aqui — ou use no site.",
    };
  }
  return {
    eyebrow: `VALE ${data.percent}% · PARA UMA AMIGA`,
    headline: "Uma amiga sua vai gostar",
    body: `${data.percent}% na primeira compra dela na ${data.storeName}, ${data.expiresLabel}. Quando ela usar, você ganha um mimo também.`,
    invite: "Entregue este cartão a ela: é só apontar a câmera.",
  };
}

/** O hash do vale: tudo o que entra no desenho, em ordem fixa. */
export function voucherFingerprint(data: VoucherCardData): string {
  return sha256Hex(JSON.stringify([data.kind, data.code, data.percent, data.expiresLabel, data.firstName, data.storeName, data.editionName, data.qrUrl]));
}
