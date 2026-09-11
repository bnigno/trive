// O post da peça: a mesma identidade dos cartões da vendedora, agora no
// formato do Instagram (post 4:5 e story 9:16), mais a legenda pronta para
// colar. Desenha uma vez e guarda (bot_cards): a segunda vez é instantânea.

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import { buildPostCaption, postEyebrow } from "@/core/cards/post";
import { categories } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  findCachedBotCard,
  publishBotCard,
  type CardRenderer,
  type PublishBotCardInput,
  type PublishedCard,
} from "@/services/bot-cards";
import { getProductDetail } from "@/services/catalog";
import { ServiceError, getSettingsMap } from "@/services/settings";
import { siteBaseUrl } from "@/services/wa-messaging";

export type ProductPost = {
  post: PublishedCard | null;
  story: PublishedCard | null;
  caption: string;
};

type PostBasis = {
  input: (kind: "post" | "story") => PublishBotCardInput;
  caption: string;
};

/** Preço do post: o da peça, ou "a partir de" quando as variações diferem. */
function priceLabelOf(prices: readonly number[]): string {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatCentsBRL(min) : `a partir de ${formatCentsBRL(min)}`;
}

async function loadBasis(db: DbOrTx, productId: string): Promise<PostBasis> {
  const detail = await getProductDetail(db as Parameters<typeof getProductDetail>[0], productId);
  const photo = detail.images[0];
  if (!photo) {
    throw new ServiceError(
      "sem_foto",
      "Esta peça ainda não tem foto — o post é a foto. Suba uma foto e tente de novo.",
    );
  }
  const prices = detail.variants
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

  return {
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
    caption: buildPostCaption({
      name: detail.name,
      priceLabel,
      categoryName,
      editionName: editionName !== "" ? editionName : null,
      storeName,
      productUrl: `${siteBaseUrl()}/produto/${detail.slug}`,
    }),
  };
}

const publishSchema = z.object({ productId: z.uuid(), userId: z.uuid() });

/** Desenha (ou reaproveita do cache) o post e o story da peça. */
export async function publishProductPost(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  input: z.input<typeof publishSchema>,
): Promise<ProductPost> {
  const parsed = publishSchema.parse(input);
  const basis = await loadBasis(db, parsed.productId);
  try {
    const post = await publishBotCard(db, storage, render, basis.input("post"));
    const story = await publishBotCard(db, storage, render, basis.input("story"));
    return { post, story, caption: basis.caption };
  } catch (error) {
    // A causa quase sempre é a foto: arquivo que sumiu do Storage ou formato
    // que o recorte não abre. Dizer isso poupa a dona de tentar de novo à toa.
    if (error instanceof Error && /storage|download|foto/i.test(error.message)) {
      throw new ServiceError(
        "foto_indisponivel",
        "Não consegui abrir a foto desta peça para montar o post. Suba a foto de novo na tela da peça e tente outra vez.",
      );
    }
    throw error;
  }
}

/** O que já está desenhado (abre a tela sem render frio). */
export async function getProductPostPreview(
  db: DbOrTx,
  storage: FileStorage,
  productId: string,
): Promise<ProductPost> {
  const basis = await loadBasis(db, z.uuid().parse(productId));
  const [post, story] = await Promise.all([
    findCachedBotCard(db, storage, basis.input("post")),
    findCachedBotCard(db, storage, basis.input("story")),
  ]);
  return { post, story, caption: basis.caption };
}

/** O JPEG do cache, servido pela própria origem (sem CORS do Storage). */
export async function getProductPostFile(
  db: DbOrTx,
  storage: FileStorage,
  input: { productId: string; format: "post" | "story" },
): Promise<{ data: Buffer; contentType: string } | null> {
  const basis = await loadBasis(db, z.uuid().parse(input.productId));
  const card = await findCachedBotCard(db, storage, basis.input(input.format));
  if (!card) return null;
  const file = await storage.download(card.path);
  return { data: file.data, contentType: file.contentType ?? "image/jpeg" };
}
