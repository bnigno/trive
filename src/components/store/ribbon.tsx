// O Laço — assinatura de movimento da maison: a fita rosé em S do monograma,
// acompanhada de um filete dourado paralelo (como no logo). Server Component;
// o movimento é CSS (globals.css): "draw" se desenha ao entrar na tela via
// <Reveal>, "hover" se desenha no hover do .group pai, "drift" flutua devagar
// (só transform) e "static" só decora. Sempre decorativo (aria-hidden).
import { cx } from "@/components/ui/cx";

type RibbonVariant = "draw" | "hover" | "drift" | "static";
type RibbonTone = "ivory" | "noir";
type RibbonSize = "sm" | "md" | "xl";

// Onda horizontal (costuras, sublinhados): dois S encadeados.
const WAVE = "M 2 12 C 40 -6, 80 30, 120 12 S 200 -6, 238 12";
// Laço vertical (palco): a curva em S que atravessa T e V.
const LOOP =
  "M 62 4 C 24 18, 22 40, 50 52 C 78 64, 80 84, 42 96";

const SIZE_CLASS: Record<RibbonSize, string> = {
  sm: "w-24",
  md: "w-40",
  xl: "w-[min(120vw,64rem)]",
};

export function Ribbon({
  variant = "static",
  tone = "ivory",
  size = "md",
  className,
}: {
  variant?: RibbonVariant;
  tone?: RibbonTone;
  size?: RibbonSize;
  className?: string;
}) {
  const vertical = size === "xl";
  const path = vertical ? LOOP : WAVE;
  // Sobre noir a fita ganha o brilho (rose-200) e o filete o ouro escovado.
  const rose = tone === "noir" ? "var(--color-rose-200)" : "var(--color-rose-300)";
  const gold = tone === "noir" ? "var(--color-gold-brush)" : "var(--color-gold-500)";
  const roseClass =
    variant === "draw" ? "ribbon-draw" : variant === "hover" ? "ribbon-hover" : undefined;
  const goldClass =
    variant === "draw"
      ? "ribbon-draw ribbon-draw-gold"
      : variant === "hover"
        ? "ribbon-hover"
        : undefined;

  return (
    <svg
      aria-hidden="true"
      viewBox={vertical ? "0 0 100 100" : "0 0 240 24"}
      fill="none"
      className={cx(
        "block shrink-0",
        SIZE_CLASS[size],
        variant === "drift" && "animate-ribbon-drift",
        className,
      )}
    >
      <path
        d={path}
        pathLength={1}
        stroke={rose}
        strokeWidth={vertical ? 3 : 2.5}
        strokeLinecap="round"
        className={roseClass}
      />
      <path
        d={path}
        pathLength={1}
        stroke={gold}
        strokeWidth={vertical ? 0.7 : 0.8}
        strokeLinecap="round"
        transform={vertical ? "translate(4 0)" : "translate(0 5)"}
        className={goldClass}
      />
    </svg>
  );
}
