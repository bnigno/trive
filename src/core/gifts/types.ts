// Presente com bilhete: limites do que a compradora escreve e os dados que o
// bilhete impresso/enviado apresenta. Puro: quem monta é services/gifts,
// quem desenha é src/receipts/render-gift-note.

export const GIFT_RECIPIENT_MAX = 80;
export const GIFT_MESSAGE_MAX = 280;
/** Linhas que cabem no bilhete de 15×10 cm com a tipografia da maison. */
export const GIFT_MESSAGE_MAX_LINES = 6;

export interface GiftNoteData {
  /** Para quem é (como a compradora escreveu, já limpo). */
  recipientName: string;
  /** Bilhete (já limpo, ≤ 6 linhas) ou null quando ela não escreveu nada. */
  message: string | null;
  /** "Com carinho, Maria" — primeiro nome da compradora. */
  signature: string;
  storeName: string;
}
