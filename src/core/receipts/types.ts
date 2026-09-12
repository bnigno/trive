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
 * O que as fontes embutidas de fato desenham (cmap do subset em
 * brand-source/fonts/subset, interseção das quatro): ASCII, Latin-1 e
 * Latin Extended-A (todo o português), traços, aspas curvas, "•", "…" e o
 * sinal de menos. Fora disso o @vercel/og buscaria fonte ou twemoji pela
 * rede dentro da função — e o comprovante não pode depender de rede.
 */
const IN_FONT = /^[\x20-\x7e\xa0-\xb4\xb6-\u017e\u2013\u2014\u2018-\u201a\u201c\u201d\u2022\u2026\u2212]$/u;

/** Um caractere fora das fontes vira o mais parecido que elas têm, ou some. */
function inFont(char: string): string {
  if (IN_FONT.test(char)) return char;
  // Compatibilidade (ﬁ → fi, "‼" → "!!", pontuação de largura inteira → ASCII).
  const compat = char.normalize("NFKC");
  if (compat !== char && [...compat].every((piece) => IN_FONT.test(piece))) return compat;
  // Letra latina com acento que o subset não tem (ẽ, ș): fica a letra base.
  const base = char.normalize("NFD").replace(/\p{M}/gu, "");
  if (base !== "" && base !== char && [...base].every((piece) => IN_FONT.test(piece))) return base;
  return "";
}

/**
 * Texto que pode entrar na imagem: só o que as fontes embutidas têm. Emoji,
 * símbolo ou letra fora do subset é trocado pelo equivalente latino ou some.
 */
export function normalizeReceiptText(value: string): string {
  const mapped = value
    // Acento composto (NFD) vira a letra pronta que a fonte tem.
    .normalize("NFC")
    // Traços, aspas e sinais tipográficos fora do subset viram os ASCII.
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/\u2032/g, "'")
    .replace(/\u2033/g, '"')
    .replace(/[\u201e\u201f]/g, '"')
    .replace(/[\u2039\u203a]/g, "'")
    .replace(/\u2030/g, "%")
    .replace(/\u203c/g, "!!")
    .replace(/\u2049/g, "?!")
    // Seletor de variação (o "️" invisível que o teclado põe depois de ‼): some.
    .replace(/[\ufe00-\ufe0f]/g, "");
  let out = "";
  for (const char of mapped) out += inFont(char);
  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?…])/g, "$1")
    .trim();
}
