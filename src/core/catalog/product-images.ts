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
export function fold(value: string): string {
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

// ---------------------------------------------------------------------------
// Foto no corpo (origin = 'ai'): onde ela aparece
// ---------------------------------------------------------------------------

/** Foto do catálogo vista pela proveniência: real (upload) ou ensaio (ai). */
export interface OriginTaggedImage {
  origin: string;
}

/**
 * hide = só fotos reais (a vitrine, até a dona ligar ai_photos_in_store);
 * prefer = a foto no corpo primeiro, as reais depois (post do Instagram,
 * cartões da Lia, vitrine com o interruptor ligado).
 */
export const AI_PHOTO_POLICIES = ["hide", "prefer"] as const;
export type AiPhotoPolicy = (typeof AI_PHOTO_POLICIES)[number];

export function isAiImage(image: OriginTaggedImage): boolean {
  return image.origin === "ai";
}

/** Aplica a política mantendo a ordem original dentro de cada grupo. */
export function orderImagesByPolicy<T extends OriginTaggedImage>(images: readonly T[], policy: AiPhotoPolicy): T[] {
  if (policy === "hide") return images.filter((image) => !isAiImage(image));
  return [...images.filter(isAiImage), ...images.filter((image) => !isAiImage(image))];
}

/**
 * A capa: com preferAi, a primeira foto no corpo (da cor pedida, quando há);
 * sem foto no corpo, ou sem preferAi, a primeira foto real. null = sem foto.
 */
export function pickCoverImage<T extends OriginTaggedImage & ColorTaggedImage>(
  images: readonly T[],
  options: { preferAi: boolean; color?: string | null } = { preferAi: true },
): T | null {
  const byColor = imagesForColor(images, options.color ?? null);
  const ordered = orderImagesByPolicy(byColor, options.preferAi ? "prefer" : "hide");
  return ordered[0] ?? (options.preferAi ? null : (byColor.find((image) => !isAiImage(image)) ?? null));
}
