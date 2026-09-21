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

/**
 * O story do lançamento (9:16): "ESTREIA · SÁBADO, 20H", até três peças —
 * atrás do véu (silhuetas desfocadas, sem preço) ou abertas (foto e preço) —
 * e o endereço da estreia. Vai para o WhatsApp da dona, que posta.
 */
export interface DropStoryCardData {
  kind: "drop_story";
  variant: "teaser" | "open";
  storeName: string;
  eyebrow: string;
  title: string;
  /** "A cortina abre sábado, às 20h" / "A cortina abriu". */
  caption: string;
  /** Peças (1–3). No teaser, imageDataUrl já vem desfocado e priceLabel vazio. */
  items: CardItem[];
  /** "trivemaison.com.br/estreia" — onde entrar na lista ou ver as peças. */
  siteLine: string;
}

/**
 * O cartão do Ateliê (4:5): a foto da peça que acabou de chegar e o resumo
 * da chegada em três linhas ("2 cores × 4 tamanhos", "24 peças · custo R$
 * 120,00", "Aurora · a pagar R$ 2.880,00"). Vai só para o WhatsApp da dona.
 */
export interface AtelierCardData {
  kind: "atelier";
  storeName: string;
  eyebrow: string;
  title: string;
  /** priceLabel = "sugerido R$ 289,90" (ou vazio). */
  hero: CardItem;
  lines: string[];
}

/**
 * "Quem já vestiu" (4:5): a foto da cliente usando a peça, uma só, com o
 * título "Ana veste Longo Dunas" e uma linha de carinho. Vai para o WhatsApp
 * dela — é o presente; a vitrine só mostra a foto com o "sim" e a aprovação.
 */
export interface CustomerLookCardData {
  kind: "customer_look";
  storeName: string;
  eyebrow: string;
  title: string;
  /** O nome da peça, sob a foto. */
  productName: string;
  /** JPEG em data URL, já recortado na moldura. */
  photoDataUrl: string;
  caption: string;
}

export type CardData = CatalogCardData | LookCardData | PostCardData | StoryCardData | DropStoryCardData | AtelierCardData | CustomerLookCardData;

export const ATELIER_EYEBROW = "ATELIÊ · RASCUNHO PRONTO";
export const ATELIER_CARD_MAX_LINES = 3;

/** Tela de cada formato, em px. O WhatsApp usa 4:5; os stories são 9:16. */
export function cardDimensions(kind: CardData["kind"]): { width: number; height: number } {
  return kind === "story" || kind === "drop_story" ? { width: 1080, height: 1920 } : { width: 1080, height: 1350 };
}

export const DROP_STORY_MAX_ITEMS = 3;

/** "ESTREIA · SÁBADO, 20H" (a faixa põe em maiúsculas; aqui só o miolo). */
export function dropStoryEyebrow(dateLabel: string): string {
  return `ESTREIA · ${dateLabel}`.toUpperCase().slice(0, 60);
}

/** A frase sob o título, por fase. */
export function dropStoryCaption(variant: DropStoryCardData["variant"], dateLabel: string): string {
  return variant === "open" ? "A cortina abriu." : `A cortina abre ${dateLabel}.`;
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
  // Os filtros também falam com o modelo ("tipo Bermuda — nenhuma com esse tipo; parecidas: …"):
  // para a cliente fica só o nome do filtro, nunca a anotação depois do travessão.
  const parts = filters
    .map((filter) =>
      filter
        .replace(/\s+—.*$/u, "")
        .replace(/^(categoria|cor|tamanho|tipo)\s+/i, "")
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
  // Ateliê: a peça grande com respiro para as três linhas do resumo.
  if (kind === "atelier") return { width: 480, height: 640 };
  // Quem já vestiu: a foto dela em 3:4, com respiro para o nome da peça e a frase.
  if (kind === "customer_look") return { width: 540, height: 720 };
  if (kind === "story") return { width: 900, height: 1200 };
  // Story do lançamento: uma peça grande, ou duas/três lado a lado, com
  // respiro para a faixa, o título, a frase e o endereço da estreia.
  if (kind === "drop_story") {
    if (count >= 3) return { width: 330, height: 440 };
    if (count === 2) return { width: 470, height: 627 };
    return { width: 660, height: 880 };
  }
  if (count >= 3) return { width: 310, height: 413 };
  if (count === 2) return { width: 440, height: 587 };
  return { width: 600, height: 800 };
}
