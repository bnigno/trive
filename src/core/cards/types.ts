// Cartão editorial da vendedora: a "vitrine" em imagem que acompanha a lista
// tocável (2–3 peças) ou o look completo (peça + 1–2 complementos). Puro:
// quem baixa as fotos e monta os dados é services/bot-cards; quem desenha é
// src/cards/render. As fotos chegam como data: URL (JPEG já cortado) porque o
// Satori não faz rede nem lê WebP.

export const CARD_MAX_ITEMS = 3;
export const LOOK_MAX_COMPLEMENTS = 2;

export interface CardItem {
  slug: string;
  name: string;
  /** "R$ 289,00" ou "a partir de R$ 189,00". */
  priceLabel: string;
  /** data:image/jpeg;base64,… já na proporção 3:4. */
  imageDataUrl: string;
}

export interface CatalogCardData {
  kind: "catalog";
  storeName: string;
  /** Linha pequena dourada na faixa noir (ex.: "VESTIDOS · PRETO"). */
  eyebrow: string;
  /** Título em itálico (ex.: "Três peças para você"). */
  title: string;
  items: CardItem[];
}

export interface LookCardData {
  kind: "look";
  storeName: string;
  eyebrow: string;
  title: string;
  hero: CardItem;
  complements: CardItem[];
}

/** O post da peça: uma foto só, grande, para o Instagram (4:5). */
export interface PostCardData {
  kind: "post";
  storeName: string;
  eyebrow: string;
  title: string;
  hero: CardItem;
}

/** O story da peça (9:16), mesma identidade em pé. */
export interface StoryCardData {
  kind: "story";
  storeName: string;
  eyebrow: string;
  title: string;
  hero: CardItem;
}

export type CardData = CatalogCardData | LookCardData | PostCardData | StoryCardData;

/** Tela de cada formato, em px. O WhatsApp usa 4:5; o story é 9:16. */
export function cardDimensions(kind: CardData["kind"]): { width: number; height: number } {
  return kind === "story" ? { width: 1080, height: 1920 } : { width: 1080, height: 1350 };
}

const COUNT_WORDS = ["", "Uma peça", "Duas peças", "Três peças"] as const;

/** "Três peças para você" / "Duas peças para você" / "Uma peça para você". */
export function catalogCardTitle(count: number): string {
  const bounded = Math.min(Math.max(count, 1), CARD_MAX_ITEMS);
  return `${COUNT_WORDS[bounded]} para você`;
}

/**
 * Eyebrow a partir dos filtros que a vendedora usou ("categoria vestidos",
 * "cor Preto", "até R$ 300,00", '"linho"'): vira "VESTIDOS · PRETO · ATÉ
 * R$ 300,00 · LINHO". Sem filtro: "A VITRINE DE HOJE".
 */
export function catalogCardEyebrow(filters: readonly string[]): string {
  const parts = filters
    .map((filter) =>
      filter
        .replace(/^(categoria|cor|tamanho)\s+/i, "")
        .replace(/^"(.*)"$/, "$1")
        .trim()
        .toUpperCase(),
    )
    .filter((part) => part !== "");
  return parts.length > 0 ? parts.join(" · ").slice(0, 60) : "A VITRINE DE HOJE";
}

export function lookCardTitle(heroName: string): string {
  return `Um look com ${heroName}`;
}

export const LOOK_EYEBROW = "O LOOK COMPLETO";

/** Tamanho (em px, 1080 de largura) de cada moldura, por layout. */
export function cardFrameSize(
  kind: CardData["kind"],
  role: "item" | "hero" | "complement",
  count: number,
): { width: number; height: number } {
  if (kind === "look") {
    return role === "hero" ? { width: 520, height: 693 } : { width: 270, height: 360 };
  }
  // Post e story: a peça ocupa a tela, com respiro para a faixa noir (≈223),
  // o título, o nome/preço da moldura e o rodapé — senão a arte sai cortada.
  if (kind === "post") return { width: 540, height: 720 };
  if (kind === "story") return { width: 900, height: 1200 };
  if (count >= 3) return { width: 310, height: 413 };
  if (count === 2) return { width: 440, height: 587 };
  return { width: 600, height: 800 };
}
