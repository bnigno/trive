// A grade da edição: cada peça ocupa as colunas que rhythmFor decide
// (7/5 · 4/4/4 · 5/7 · 4/4/4 no desktop; capas de largura total no celular).
// O wrapper de cada card é filho direto do grid — é nele que moram os spans e
// o deslocamento vertical, nunca no card. Server Component.
import { ProductCard } from "@/components/store/product-card";
import { Reveal } from "@/components/store/reveal";
import { rhythmFor } from "@/lib/editorial-rhythm";
import type { PublicProductListItem } from "@/services/store-catalog";

export function EditorialGrid({
  products,
  revealCount = 12,
  priorityIndex = -1,
}: {
  products: PublicProductListItem[];
  /** Quantas peças entram com <Reveal> (as demais nascem prontas). */
  revealCount?: number;
  /** Índice da foto que carrega com prioridade (LCP); -1 = nenhuma. */
  priorityIndex?: number;
}) {
  const total = products.length;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-10 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-16">
      {products.map((product, index) => {
        const rhythm = rhythmFor(index, total);
        const card = (
          <ProductCard
            product={product}
            size={rhythm.size}
            sizes={rhythm.sizes}
            priority={index === priorityIndex}
            frame={false}
          />
        );
        return index < revealCount ? (
          <Reveal
            key={product.id}
            delay={(index % 3) * 70}
            className={rhythm.className}
          >
            {card}
          </Reveal>
        ) : (
          <div key={product.id} className={rhythm.className}>
            {card}
          </div>
        );
      })}
    </div>
  );
}
