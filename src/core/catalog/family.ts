// O que NÃO é roupa no catálogo — PURO. Utilidades da sala "Casa" (caneca,
// garrafa, caderno) existem no seed e podem existir na loja: a Lia não monta
// look com elas e o cartão da edição não fala em "vestir" nem "lavar".
// No nome, só a PRIMEIRA palavra veta ("Caneca Azul", "Garrafa Térmica"):
// "Vestido Copo-de-Leite" e "Blusa Verde Garrafa" são roupa com nome de
// flor e de cor. Na categoria, "Casa" só quando é a sala inteira — "Moda
// Casa" (robe, pijama) é roupa.

import { fold } from "@/core/catalog/product-images";

/** Um item que não se veste, quando é a primeira palavra do nome (ou o kit). */
const NOT_CLOTHING_NAME = /^(canecas?|garrafas?|copos?|cadernos?|adesivos?|kit (de )?adesivos)\b/;
/** Uma sala que não é de roupa. */
const NOT_CLOTHING_CATEGORY = /^casa$|\b(decoracao|utilidades|papelaria)\b/;

export function isNotClothing(categoryName: string | null | undefined, name: string): boolean {
  return NOT_CLOTHING_NAME.test(fold(name).trim()) || NOT_CLOTHING_CATEGORY.test(fold(categoryName ?? "").trim());
}
