// Monograma provisório da maison — fonte única da verdade do símbolo.
// Quando o dono enviar o logo real: colar o SVG aqui (e em src/app/icon.svg)
// mantendo as props (size, tone, className). O véu (brand-veil.tsx) replica
// este desenho inline — manter em sincronia na troca.
import { cx } from "@/components/ui/cx";

// "T" serifado desenhado em path (não <text>): barra com brackets côncavos
// nas pontas e serifas de pé abertas — assinatura da marca.
export const MONOGRAM_T_PATH =
  "M 20.2 24.6 L 43.8 24.6 L 43.8 30.2 C 43.3 27.9 42.4 27.1 39.8 27 " +
  "L 34.3 27 L 34.3 42.4 C 34.3 44.3 35.2 44.8 38.1 45 L 38.1 45.9 " +
  "L 25.9 45.9 L 25.9 45 C 28.8 44.8 29.7 44.3 29.7 42.4 L 29.7 27 " +
  "L 24.2 27 C 21.6 27.1 20.7 27.9 20.2 30.2 Z";

// Trema do Ë: dois pontos acima da barra do T.
export const MONOGRAM_TREMA: ReadonlyArray<{ cx: number; cy: number }> = [
  { cx: 28.8, cy: 20.8 },
  { cx: 35.2, cy: 20.8 },
];

type MonogramProps = {
  size?: number;
  /** "ink" (padrão, fundos claros) ou "gold" (fundos escuros: sem disco). */
  tone?: "ink" | "gold";
  className?: string;
};

export function Monogram({ size = 40, tone = "ink", className }: MonogramProps) {
  const onDark = tone === "gold";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cx("shrink-0", className)}
    >
      {/* Disco ink (some no tom gold — o anel e o T fazem a marca) */}
      {onDark ? null : (
        <circle cx="32" cy="32" r="31" fill="var(--color-ink-950)" />
      )}
      {/* Anel dourado hairline */}
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke={onDark ? "var(--color-gold-400)" : "var(--color-gold-500)"}
        strokeWidth="1"
      />
      <path
        d={MONOGRAM_T_PATH}
        fill={onDark ? "var(--color-gold-300)" : "var(--color-gold-400)"}
      />
      {MONOGRAM_TREMA.map((dot) => (
        <circle
          key={dot.cx}
          cx={dot.cx}
          cy={dot.cy}
          r="1.5"
          fill={onDark ? "var(--color-gold-300)" : "var(--color-gold-400)"}
        />
      ))}
    </svg>
  );
}
