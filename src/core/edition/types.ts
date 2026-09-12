// O cartão da edição que vai na caixa, um por peça — PURO. O que o desenho
// precisa saber, já em texto pronto: nome, a frase da curadora (se houver),
// como vestir em Belém, cuidados na umidade e o endereço da peça (vira QR).

export interface EditionCardData {
  /** "TRIVÉ" ou o nome configurado da loja. */
  storeName: string;
  /** "EDIÇÃO CÍRIO" — a faixa pequena; null = "NOITE DE ESTREIA". */
  editionName: string | null;
  productName: string;
  /** A frase da curadora, já limpa; null = o cartão não mostra a seção. */
  curatorNote: string | null;
  /** "Como vestir em Belém" — da ficha ou o padrão da categoria. */
  wearNote: string;
  /** "Cuidados na umidade" — da ficha ou o padrão. */
  careNote: string;
  /** Endereço público da peça: o QR aponta para cá. */
  productUrl: string;
}
