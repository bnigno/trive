// O cartão da edição que vai na caixa, um por peça — PURO. O que o desenho
// precisa saber, já em texto pronto: nome, a frase da curadora (se houver),
// como vestir em Belém, cuidados na umidade e o endereço da peça (vira QR).

export interface EditionCardData {
  /** "EDIÇÃO CÍRIO" — a faixa pequena; null = "NOITE DE ESTREIA". */
  editionName: string | null;
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
}
