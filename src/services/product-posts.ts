// O post da peça: a mesma identidade dos cartões da vendedora, agora no
// formato do Instagram (post 4:5 e story 9:16), mais a legenda pronta para
// colar. Desenha uma vez e guarda (bot_cards): a segunda vez é instantânea.

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import {
  buildPostCaption,
  carouselColors,
  carouselEyebrow,
  postEyebrow,
  type CarouselEntry,
  type PostCaptionInput,
} from "@/core/cards/post";
import { VIDEO_CAPTION_NOTICE } from "@/core/studio/video";
import { fold, orderImagesByPolicy, pickCoverImage } from "@/core/catalog/product-images";
import { categories, products } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  findCachedBotCard,
  PhotoUnavailableError,
  publishBotCard,
  type CardRenderer,
  type PublishBotCardInput,
  type PublishedCard,
} from "@/services/bot-cards";
import { ServiceError as CatalogServiceError, getProductDetail } from "@/services/catalog";
import { ServiceError, getSettingsMap } from "@/services/settings";
import { siteBaseUrl } from "@/services/wa-messaging";

export type CarouselCard = {
  color: string;
  card: PublishedCard | null;
  /** Por que esta cor ficou sem cartão (foto que não abre), em português. */
  problem: string | null;
};

export type ProductPost = {
  slug: string;
  post: PublishedCard | null;
  story: PublishedCard | null;
  /** Uma imagem por cor, na ordem das variações (vazio = sem carrossel). */
  carousel: CarouselCard[];
  /** Cores que caberiam no carrossel mas passaram do teto do Instagram. */
  omittedColors: string[];
  caption: string;
};

type PostBasis = {
  slug: string;
  name: string;
  postCardPath: string | null;
  input: (kind: "post" | "story") => PublishBotCardInput;
  /** Cartão 4:5 de UMA cor da peça (a faixa diz a cor, o preço é o dela). */
  colorInput: (entry: CarouselEntry) => PublishBotCardInput;
  colors: CarouselEntry[];
  omittedColors: string[];
  caption: string;
  /** O que gerou a legenda (o vídeo refaz a mesma legenda com o aviso de IA). */
  captionInput: PostCaptionInput;
};

/** Preço do post: o da peça, ou "a partir de" quando as variações diferem. */
function priceLabelOf(prices: readonly number[]): string {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatCentsBRL(min) : `a partir de ${formatCentsBRL(min)}`;
}

/** Só a foto que não serve é problema da dona; falha do desenho segue para o retry. */
function isPhotoError(error: unknown): boolean {
  return error instanceof PhotoUnavailableError;
}

function photoProblem(name: string, color: string | null): ServiceError {
  const which = color ? `a foto da cor ${color} de ${name}` : `a foto de ${name}`;
  return new ServiceError(
    "foto_indisponivel",
    `Não consegui abrir ${which} para montar o post. Suba a foto de novo na tela da peça e tente outra vez.`,
  );
}

async function loadBasis(db: DbOrTx, productId: string): Promise<PostBasis> {
  let detail: Awaited<ReturnType<typeof getProductDetail>>;
  try {
    detail = await getProductDetail(db as Parameters<typeof getProductDetail>[0], productId);
  } catch (error) {
    // O catálogo tem a sua própria classe de erro: quem chama este serviço
    // (tela, handler) só conhece a daqui.
    if (error instanceof CatalogServiceError && error.code === "nao_encontrado") {
      throw new ServiceError("nao_encontrado", error.message);
    }
    throw error;
  }
  // A capa é a foto no corpo (a primeira, por ordem) quando existe; o
  // carrossel fica com as fotos reais, uma por cor — a esticada ao lado.
  const photo = pickCoverImage(detail.images, { preferAi: true });
  if (!photo) {
    throw new ServiceError(
      "sem_foto",
      "Esta peça ainda não tem foto — o post é a foto. Suba uma foto e tente de novo.",
    );
  }
  if (detail.status !== "active") {
    throw new ServiceError(
      "peca_nao_publicada",
      "Esta peça ainda não está na vitrine — o link da legenda daria em página não encontrada. Publique a peça e volte aqui.",
    );
  }
  if (detail.visibleFrom && detail.visibleFrom.getTime() > Date.now()) {
    throw new ServiceError(
      "peca_agendada",
      "Esta peça ainda não apareceu na loja (tem data para entrar na vitrine). Espere a estreia ou tire a data e volte aqui.",
    );
  }
  // Só variação vendável entra no preço: anunciar "a partir de" com variação
  // desativada é prometer um valor que a loja não vende.
  const prices = detail.variants
    .filter((variant) => variant.isActive)
    .map((variant) => variant.activePriceCents)
    .filter((price): price is number => price !== null);
  if (prices.length === 0) {
    throw new ServiceError(
      "sem_preco",
      "Esta peça ainda não tem preço ativo. Defina o preço e tente de novo.",
    );
  }

  const [settingsMap, category] = await Promise.all([
    getSettingsMap(db, ["store_name", "edition_name"]),
    detail.categoryId
      ? db
          .select({ name: categories.name })
          .from(categories)
          .where(eq(categories.id, detail.categoryId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const text = (key: string): string =>
    typeof settingsMap[key] === "string" ? (settingsMap[key] as string) : "";
  const storeName = text("store_name") !== "" ? text("store_name") : "TRIVÉ";
  const editionName = text("edition_name");
  const categoryName = category[0]?.name ?? null;
  const priceLabel = priceLabelOf(prices);
  const captionInput: PostCaptionInput = {
    name: detail.name,
    priceLabel,
    categoryName,
    editionName: editionName !== "" ? editionName : null,
    storeName,
    productUrl: `${siteBaseUrl()}/produto/${detail.slug}`,
  };

  const plan = carouselColors({
    attributesSchema: detail.attributesSchema,
    variants: detail.variants,
    images: orderImagesByPolicy(detail.images, "hide"),
  });

  return {
    slug: detail.slug,
    name: detail.name,
    postCardPath: detail.postCardPath,
    colors: plan.entries,
    omittedColors: plan.omitted,
    colorInput: (entry) => ({
      kind: "post",
      storeName,
      eyebrow: carouselEyebrow(editionName, entry.color),
      title: detail.name,
      items: [
        {
          slug: detail.slug,
          name: detail.name,
          // O preço daquela cor; sem preço próprio informado, o da peça.
          priceLabel: entry.priceCents.length > 0 ? priceLabelOf(entry.priceCents) : priceLabel,
          imagePath: entry.imagePath,
        },
      ],
    }),
    input: (kind) => ({
      kind,
      storeName,
      eyebrow: postEyebrow(editionName),
      title: detail.name,
      items: [
        {
          slug: detail.slug,
          name: detail.name,
          priceLabel,
          imagePath: photo.storagePath,
        },
      ],
    }),
    caption: buildPostCaption(captionInput),
    captionInput,
  };
}

/** É este cartão que a prévia do link mostra no WhatsApp e no Instagram. */
async function setPostCardPath(db: DbOrTx, productId: string, path: string | null): Promise<void> {
  await db
    .update(products)
    .set({ postCardPath: path, updatedAt: new Date() })
    .where(eq(products.id, productId));
}

/** Post e story: sem eles não há nada; erro de foto sai traduzido. */
async function publishMainCards(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  productId: string,
  basis: PostBasis,
): Promise<{ post: PublishedCard; story: PublishedCard }> {
  let post: PublishedCard;
  try {
    post = await publishBotCard(db, storage, render, basis.input("post"));
  } catch (error) {
    if (isPhotoError(error)) throw photoProblem(basis.name, null);
    throw error;
  }
  // Gravado antes do carrossel: uma cor com foto ruim não deixa o link sem prévia.
  if (basis.postCardPath !== post.path) await setPostCardPath(db, productId, post.path);
  let story: PublishedCard;
  try {
    story = await publishBotCard(db, storage, render, basis.input("story"));
  } catch (error) {
    if (isPhotoError(error)) throw photoProblem(basis.name, null);
    throw error;
  }
  return { post, story };
}

/** Cada cor por si: a que não abre fica sem cartão e diz qual foi. */
async function publishCarousel(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  basis: PostBasis,
): Promise<CarouselCard[]> {
  const carousel: CarouselCard[] = [];
  for (const entry of basis.colors) {
    try {
      const card = await publishBotCard(db, storage, render, basis.colorInput(entry));
      carousel.push({ color: entry.color, card, problem: null });
    } catch (error) {
      if (!isPhotoError(error)) throw error;
      carousel.push({ color: entry.color, card: null, problem: photoProblem(basis.name, entry.color).message });
    }
  }
  return carousel;
}

const publishSchema = z.object({ productId: z.uuid(), userId: z.uuid() });

/** Desenha (ou reaproveita do cache) o post, o story e o carrossel da peça. */
export async function publishProductPost(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  input: z.input<typeof publishSchema>,
): Promise<ProductPost> {
  const parsed = publishSchema.parse(input);
  const basis = await loadBasis(db, parsed.productId);
  const { post, story } = await publishMainCards(db, storage, render, parsed.productId, basis);
  const carousel = await publishCarousel(db, storage, render, basis);
  return { slug: basis.slug, post, story, carousel, omittedColors: basis.omittedColors, caption: basis.caption };
}

/** O que já está desenhado (abre a tela sem render frio). */
export async function getProductPostPreview(
  db: DbOrTx,
  storage: FileStorage,
  productId: string,
): Promise<ProductPost> {
  const id = z.uuid().parse(productId);
  const basis = await loadBasis(db, id);
  const [post, story, ...cards] = await Promise.all([
    findCachedBotCard(db, storage, basis.input("post")),
    findCachedBotCard(db, storage, basis.input("story")),
    ...basis.colors.map((entry) => findCachedBotCard(db, storage, basis.colorInput(entry))),
  ]);
  // Peça desenhada antes de existir a prévia do link (ou com o caminho
  // perdido): o cache já tem o cartão certo, então a coluna se cura aqui.
  if (post && basis.postCardPath !== post.path) await setPostCardPath(db, id, post.path);
  return {
    slug: basis.slug,
    post,
    story,
    carousel: basis.colors.map((entry, index) => ({ color: entry.color, card: cards[index], problem: null })),
    omittedColors: basis.omittedColors,
    caption: basis.caption,
  };
}

/** "longo-dunas-terracota.jpg": nome do arquivo baixado, só ASCII. */
function downloadFilename(slug: string, suffix: string, extension: "jpg" | "mp4" = "jpg"): string {
  const clean = (value: string) =>
    fold(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `${clean(slug)}-${clean(suffix)}.${extension}`;
}

/**
 * O vídeo da peça para o Instagram: a legenda do post com o aviso de IA
 * ("Imagem ilustrativa…") e o nome do arquivo baixado. Sem post possível
 * (sem preço, sem foto, fora da vitrine) a legenda é null — o aviso sozinho
 * a tela mostra mesmo assim.
 */
export async function getProductVideoCaption(
  db: DbOrTx,
  productId: string,
): Promise<{ caption: string | null; filename: string; slug: string | null }> {
  const id = z.uuid().parse(productId);
  try {
    const basis = await loadBasis(db, id);
    return {
      caption: buildPostCaption({ ...basis.captionInput, notice: VIDEO_CAPTION_NOTICE }),
      filename: downloadFilename(basis.slug, "video", "mp4"),
      slug: basis.slug,
    };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { caption: null, filename: downloadFilename(id, "video", "mp4"), slug: null };
  }
}

/** O JPEG do cache, servido pela própria origem (sem CORS do Storage). */
export async function getProductPostFile(
  db: DbOrTx,
  storage: FileStorage,
  input: { productId: string; format: "post" | "story" | `carousel-${number}` },
): Promise<{ data: Buffer; contentType: string; filename: string } | null> {
  const basis = await loadBasis(db, z.uuid().parse(input.productId));
  const carouselIndex = input.format.startsWith("carousel-")
    ? Number(input.format.slice("carousel-".length))
    : null;
  const entry = carouselIndex === null ? null : basis.colors[carouselIndex];
  const request =
    carouselIndex === null
      ? basis.input(input.format as "post" | "story")
      : entry
        ? basis.colorInput(entry)
        : null;
  if (!request) return null;
  const card = await findCachedBotCard(db, storage, request);
  if (!card) return null;
  const file = await storage.download(card.path);
  return {
    data: file.data,
    contentType: file.contentType ?? "image/jpeg",
    filename: downloadFilename(basis.slug, entry ? entry.color : input.format),
  };
}

/**
 * Situações em que não há o que desenhar — não são falha: a peça sumiu, não
 * tem foto ou preço, voltou a rascunho ou ainda não estreou. O handler trata
 * como concluído (sem retry, sem "Fila com problemas").
 */
export const PRERENDER_SKIP_CODES = [
  "nao_encontrado",
  "sem_foto",
  "sem_preco",
  "peca_nao_publicada",
  "peca_agendada",
] as const;
export type PrerenderSkipCode = (typeof PRERENDER_SKIP_CODES)[number];

export type PrerenderResult =
  | { skipped: PrerenderSkipCode; visibleFrom: Date | null }
  | {
      skipped: null;
      slug: string;
      post: boolean;
      story: boolean;
      colors: number;
      /** Cores que ficaram sem cartão (foto que não abre), para o log. */
      colorProblems: string[];
    };

function isSkipCode(code: string): code is PrerenderSkipCode {
  return (PRERENDER_SKIP_CODES as readonly string[]).includes(code);
}

/**
 * Pré-desenha o post, o story e o carrossel quando a peça entra na vitrine
 * ou muda o que está no cartão (handlers de product.published e
 * product.card_refresh). Idempotente: o que já está no cache não é desenhado
 * de novo, então o retry nunca refaz trabalho.
 */
export async function prerenderProductPosts(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  input: { productId: string },
): Promise<PrerenderResult> {
  const productId = z.uuid().parse(input.productId);
  let basis: PostBasis;
  try {
    basis = await loadBasis(db, productId);
  } catch (error) {
    if (!(error instanceof ServiceError) || !isSkipCode(error.code)) throw error;
    // Sem base para um cartão válido, a prévia do link volta a ser a foto:
    // cartão velho com preço que a loja não pratica é pior do que nenhum.
    if (error.code === "sem_foto" || error.code === "sem_preco" || error.code === "peca_nao_publicada") {
      await setPostCardPath(db, productId, null);
    }
    const [row] =
      error.code === "peca_agendada"
        ? await db.select({ visibleFrom: products.visibleFrom }).from(products).where(eq(products.id, productId)).limit(1)
        : [];
    return { skipped: error.code, visibleFrom: row?.visibleFrom ?? null };
  }
  const { post, story } = await publishMainCards(db, storage, render, productId, basis);
  const carousel = await publishCarousel(db, storage, render, basis);
  return {
    skipped: null,
    slug: basis.slug,
    post: !post.cached,
    story: !story.cached,
    colors: basis.colors.length,
    colorProblems: carousel.filter((entry) => entry.problem !== null).map((entry) => entry.color),
  };
}
