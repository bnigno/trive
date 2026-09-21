import { cx } from "./cx";

/**
 * Linha de tendência de bolso (12–14 pontos) para o canto de um StatCard.
 * Decorativa: o número que importa está no texto do card, por isso aria-hidden.
 * Cor pelo caller (currentColor); o anel do ponto final é da cor da superfície.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length === 0) return null;

  const pad = 4;
  const max = Math.max(...values, 0);
  const innerWidth = width - pad * 2;
  const innerHeight = height - pad * 2;
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = pad + index * step;
    // Tudo zero → linha reta na base, não no meio.
    const y = max > 0 ? pad + innerHeight - (value / max) * innerHeight : pad + innerHeight;
    return { x, y };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      className={cx("shrink-0 overflow-visible", className)}
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={6} className="fill-white dark:fill-zinc-900" />
      <circle cx={last.x} cy={last.y} r={4} fill="currentColor" />
    </svg>
  );
}
