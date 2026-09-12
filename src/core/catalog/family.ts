// O que NÃO é roupa no catálogo — PURO. Utilidades da sala "Casa" (caneca,
// garrafa, caderno) existem no seed e podem existir na loja: a Lia não monta
// look com elas e o cartão da edição não fala em "vestir" nem "lavar".
// Palavra inteira, para "copo" não pegar "corpo" nem "casa" pegar "casaco".

import { fold } from "@/core/catalog/product-images";

/** Um item que não se veste, pelo nome ou pela categoria. */
const NOT_CLOTHING_ITEM = /\b(canecas?|garrafas?|copos?|cadernos?|adesivos?|kit de adesivos)\b/;
/** Uma sala que não é de roupa (só vale para a categoria). */
const NOT_CLOTHING_CATEGORY = /\b(casa|decoracao|utilidades|papelaria)\b/;

export function isNotClothing(categoryName: string | null | undefined, name: string): boolean {
  const category = fold(categoryName ?? "");
  return NOT_CLOTHING_ITEM.test(fold(name)) || NOT_CLOTHING_ITEM.test(category) || NOT_CLOTHING_CATEGORY.test(category);
}
