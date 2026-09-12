// O cartão da edição que vai na caixa, um por peça — PURO. O que o desenho
// precisa saber, já em texto pronto: nome, a frase da curadora (se houver),
// como vestir em Belém, cuidados na umidade e o endereço da peça (vira QR).

/**
 * Os corpos e as linhas escolhidos pelo orçamento de altura
 * (core/edition/layout.ts): o desenho trava cada bloco nessas linhas.
 */
export interface EditionCardLayout {
  titleSize: number;
  titleLines: number;
  quoteSize: number;
  quoteLines: number;
  bodySize: number;
  wearLines: number;
  careLines: number;
  qrSize: number;
}

export interface EditionCardData {
  /** "EDIÇÃO CÍRIO" — a faixa pequena; null = "NOITE DE ESTREIA". */
  editionName: string | null;
  /** O nome da peça como sai no título (já no teto de duas linhas). */
  productName: string;
  /** A frase da curadora, já limpa; null = o cartão não mostra a seção. */
  curatorNote: string | null;
  /** O quadro de cima: "Como veste" da ficha ou o padrão de Belém. */
  wearNote: string;
  /** "ficha" → rótulo "COMO VESTE"; "padrao" → "COMO VESTIR EM BELÉM". */
  wearSource: "ficha" | "padrao";
  /** "Cuidados na umidade" — da ficha ou o padrão. */
  careNote: string;
  /** O que o QR abre: a página da peça — ou a home, quando o pedido é presente. */
  qrUrl: string;
  /** Muda o convite ao lado do QR: "veja a peça" ou "conheça a maison". */
  qrTarget: "peca" | "home";
  /** O que sai escrito sob o QR: só o domínio ("trivemaison.com.br"). */
  printedAddress: string;
  layout: EditionCardLayout;
}

/** A carta de estreia (15 × 10 cm) que vai na caixa da primeira compra. */
export interface DebutLetterData {
  /** Primeiro nome da cliente, para "PARA ANA". */
  recipientName: string;
  /** O texto que a dona escreveu, já limpo (≤ 12 linhas). */
  text: string;
  /** "Marina, curadora da TRIVÉ" — como a dona assina. */
  signature: string;
  editionName: string | null;
}
