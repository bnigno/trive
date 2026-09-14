// Wordmark: as letras TRIVÉ do logo em SVG inline (paths gerados de
// brand-source/logo.svg por scripts/generate-brand-assets.mjs), pintadas com
// a cor do texto (currentColor) — a mesma peça serve sobre marfim e sobre
// noir. O nome continua vivo: o SVG só aparece quando o nome da loja é TRIVÉ
// (em qualquer grafia do acento — TRIVË, Trive…, que o banco já teve); outro
// nome cai no texto em Cormorant, para o painel poder renomear a loja sem
// quebrar a vitrine. Tamanho pela prop `height`; cor pelo caller.
import { useId } from "react";

import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { cx } from "@/components/ui/cx";

import { WORDMARK_LETTERING } from "./lettering.generated";

/** Minúsculas, sem acentos: "TRIVÉ", "TRIVË" e "Trive" são o mesmo nome. */
function foldName(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

const LETTERING_NAME = foldName(STORE_NAME_DEFAULT);
/** A caixa do letreiro inclui o acento do É: as maiúsculas têm ~2/3 da altura. */
const CAP_RATIO = 106 / WORDMARK_LETTERING.height;

/** O nome da loja (settings) é o do logo? Fora isso o letreiro não vale. */
export function isLetteringName(storeName: string): boolean {
  return foldName(storeName) === LETTERING_NAME;
}

export function Wordmark({
  children,
  height = 16,
  sheen = false,
  className,
}: {
  /** Nome da loja, vindo dos settings. */
  children: string;
  /** Altura do letreiro em px (a largura segue a proporção). Sobrescreva com `w-* h-auto` quando fluido. */
  height?: number;
  /** Hero: ouro com um brilho que varre uma vez depois do véu (ver .wordmark-sheen em globals.css). */
  sheen?: boolean;
  className?: string;
}) {
  const id = useId();
  const { viewBox, width: boxWidth, height: boxHeight, glyphs } = WORDMARK_LETTERING;
  const width = Math.round((height * boxWidth) / boxHeight);

  if (!isLetteringName(children)) {
    // Mesma altura de maiúscula do letreiro, limitada para o nome caber na
    // tela (cada letra ocupa ~1,05em com o tracking).
    const capPx = Math.round(height * CAP_RATIO * 1.55);
    const fit = `calc(90vw / ${(children.trim().length * 1.05).toFixed(1)})`;
    return (
      <span
        className={cx("font-display font-semibold tracking-[0.3em]", className)}
        style={{ fontSize: `min(${capPx}px, ${fit})`, lineHeight: 1 }}
      >
        {children}
      </span>
    );
  }

  const paths = glyphs.map((glyph) => (
    <path key={`${glyph.x},${glyph.y}`} transform={`translate(${glyph.x} ${glyph.y})`} d={glyph.d} />
  ));
  // No sheen o ouro é um gradiente num retângulo recortado pelas letras
  // (background-clip: text não vale para SVG): a faixa do brilho tem 2,2× a
  // largura do letreiro e sobra ouro liso de cada lado, para as letras
  // continuarem cobertas nas duas pontas da varredura (±0,84 da largura).
  const box = viewBox.split(" ").map(Number);
  const sheenWidth = box[2] * 4.2;

  return (
    <span className="inline-flex">
      <svg
        aria-hidden="true"
        focusable="false"
        width={width}
        height={height}
        viewBox={viewBox}
        fill="currentColor"
        className={cx("block shrink-0", className)}
      >
        {sheen ? (
          <>
            <defs>
              <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="var(--color-gold-700)" />
                <stop offset="0.238" stopColor="var(--color-gold-700)" />
                <stop offset="0.421" stopColor="var(--color-gold-brush)" />
                <stop offset="0.5" stopColor="var(--color-gold-200)" />
                <stop offset="0.579" stopColor="var(--color-gold-brush)" />
                <stop offset="0.762" stopColor="var(--color-gold-700)" />
                <stop offset="1" stopColor="var(--color-gold-700)" />
              </linearGradient>
              <clipPath id={`${id}-clip`}>{paths}</clipPath>
            </defs>
            <g clipPath={`url(#${id}-clip)`}>
              <rect
                className="wordmark-sheen"
                x={box[0] - (sheenWidth - box[2]) / 2}
                y={box[1]}
                width={sheenWidth}
                height={box[3]}
                fill={`url(#${id}-gold)`}
              />
            </g>
          </>
        ) : (
          paths
        )}
      </svg>
      <span className="sr-only">{children}</span>
    </span>
  );
}
