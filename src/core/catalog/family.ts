// O que NÃO é roupa no catálogo — PURO. Utilidades da sala "Casa" (caneca,
// garrafa, caderno) existem no seed e podem existir na loja: a Lia não monta
// look com elas e o cartão da edição não fala em "vestir" nem "lavar".

/** Casa com o nome ou a categoria de algo que não se veste. */
export const NOT_CLOTHING = /caneca|garrafa|adesivo|copo|decora|casa\b|caderno|kit de adesivos|t[eé]rmic/i;

export function isNotClothing(categoryName: string | null | undefined, name: string): boolean {
  return NOT_CLOTHING.test(`${categoryName ?? ""} ${name}`);
}
