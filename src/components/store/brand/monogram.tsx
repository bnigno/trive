// Monograma da maison (T e V entrelaçados pela fita rosé). A fonte da verdade
// é brand-source/*.svg; este componente só exibe os rasters gerados por
// scripts/generate-brand-assets.mjs (ver assets.ts), com width/height reais
// para a marca nunca causar CLS.
import { cx } from "@/components/ui/cx";

import { BRAND, type BrandImage } from "./assets";

type MonogramProps = {
  /** Largura em px; a altura segue a proporção do desenho. */
  size?: number;
  /**
   * "ink" (padrão): versão clara — espresso, ouro e rosé — para fundos marfim.
   * "gold": versão escura em ouro escovado, desenhada para fundos noir; fora
   * deles perde o contraste, então só use sobre `bg-ink-950`/noir.
   */
  tone?: "ink" | "gold";
  className?: string;
  /** Imagem acima da dobra que define o LCP (hero): busca com prioridade alta. */
  priority?: boolean;
  /** Variante escondida por CSS (ex.: logo alternativo do header): sem caixa visível, lazy não baixa. */
  lazy?: boolean;
};

function srcSetOf(variants: readonly BrandImage[]): string {
  return variants.map((variant) => `${variant.src} ${variant.width}w`).join(", ");
}

export function Monogram({
  size = 40,
  tone = "ink",
  className,
  priority = false,
  lazy = false,
}: MonogramProps) {
  const mark = tone === "gold" ? BRAND.dark.mark : BRAND.light.mark;
  const largest = mark[mark.length - 1];
  const height = Math.round((size * largest.height) / largest.width);
  // Fallback para quem ignora srcset: a primeira variante com 2× de densidade.
  const fallback = mark.find((variant) => variant.width >= size * 2) ?? largest;

  return (
    <img
      src={fallback.src}
      srcSet={srcSetOf(mark)}
      sizes={`${size}px`}
      width={size}
      height={height}
      alt=""
      aria-hidden="true"
      decoding="async"
      draggable={false}
      loading={lazy ? "lazy" : undefined}
      fetchPriority={priority ? "high" : undefined}
      className={cx("shrink-0 select-none", className)}
    />
  );
}
