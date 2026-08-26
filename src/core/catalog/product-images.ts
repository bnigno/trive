// Quais fotos a vitrine mostra quando o cliente escolhe uma cor.
// Puro de propósito: a página do produto é RSC e o componente cliente só
// apresenta — a regra de "o que aparece" mora aqui e é testável sozinha.

/** Foto do catálogo vista pelo lado da cor; null = foto do produto inteiro. */
export interface ColorTaggedImage {
  color: string | null;
}

/**
 * Compara nomes de cor/eixo pelo sentido, não pela grafia: tira acento, apara
 * espaço e rebaixa a caixa. O banco guarda o valor já normalizado, mas a
 * comparação tolerante evita que "Verde " ou "COR" sumam da tela por um detalhe
 * de digitação vindo de um cadastro antigo.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * O eixo de cor declarado no produto ("Cor", "cor" e "côr" são o mesmo eixo),
 * devolvido com a grafia original — é essa grafia que indexa os atributos da
 * variante. Produto sem eixo de cor devolve null.
 */
export function findColorAxis(attributesSchema: unknown): string | null {
  const axes = Array.isArray(attributesSchema) ? attributesSchema : [];
  return (
    axes.find(
      (axis): axis is string => typeof axis === "string" && fold(axis) === "cor",
    ) ?? null
  );
}

/** Foto sem cor: vale para o produto inteiro e aparece em qualquer escolha. */
function isForWholeProduct(image: ColorTaggedImage): boolean {
  return image.color === null || fold(image.color) === "";
}

/**
 * As fotos da cor escolhida primeiro, depois as do produto inteiro.
 *
 * A ordem importa: a galeria abre na primeira foto da lista, então a cor
 * escolhida precisa vir na frente para o cliente ver o que ele acabou de
 * escolher. Cor sem foto própria cai nas do produto inteiro — a galeria nunca
 * fica vazia por causa da escolha, só quando o produto realmente não tem foto.
 * Sem cor escolhida (produto sem eixo de cor), tudo aparece na ordem original.
 */
export function imagesForColor<T extends ColorTaggedImage>(
  images: readonly T[],
  color: string | null,
): T[] {
  if (!color || fold(color) === "") return [...images];

  const wanted = fold(color);
  const ofColor = images.filter(
    (image) => !isForWholeProduct(image) && fold(image.color ?? "") === wanted,
  );
  return [...ofColor, ...images.filter(isForWholeProduct)];
}
