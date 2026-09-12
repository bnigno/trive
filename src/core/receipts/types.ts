// Comprovante de pagamento: os dados que a imagem apresenta (sem nenhum dado
// pessoal — a imagem circula em encaminhamentos) e a limpeza do texto que
// entra nela. Puro: quem monta os dados é services/receipts, quem desenha é
// src/receipts/render.

export interface ReceiptItem {
  name: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export interface ReceiptData {
  orderNumber: number;
  paidAt: Date;
  /** Rótulo curto da forma de pagamento ("Pix", "Cartão", "Dinheiro na entrega"…). */
  paymentLabel: string;
  items: ReceiptItem[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  storeName: string;
  /** null = o dono ainda não preencheu; a linha some da imagem. */
  storeCnpj: string | null;
}

export interface ReceiptFont {
  name: string;
  data: Buffer;
  weight: 400 | 500 | 600;
  style: "normal" | "italic";
}

export interface ReceiptAssets {
  fonts: ReceiptFont[];
  /** Lockup dourado sobre transparente (PNG): o Satori não aceita WebP. */
  lockupDarkPng: Buffer;
}

/**
 * Texto que pode entrar na imagem: só letras latinas, números, pontuação e
 * espaços. Emoji ou símbolo fora disso faria o @vercel/og buscar fonte/twemoji
 * pela rede dentro da função — e o comprovante não pode depender de rede.
 */
export function normalizeReceiptText(value: string): string {
  return (
    value
      // Acento composto (NFD) vira a letra pronta que a fonte tem.
      .normalize("NFC")
      // Traços e aspas tipográficos fora do subset das fontes viram os ASCII.
      .replace(/[\u2010\u2011]/g, "-")
      .replace(/\u2032/g, "'")
      .replace(/\u2033/g, '"')
      // Símbolos que uma ficha usa ("30°C", "R$", "2+1", "×", "%") ficam.
      .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}°$+×%]/gu, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:!?…])/g, "$1")
      .trim()
  );
}
