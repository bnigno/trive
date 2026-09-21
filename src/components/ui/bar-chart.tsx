import { cx } from "./cx";

export type BarChartPoint = {
  /** Rótulo curto do eixo ("14/09"). */
  label: string;
  value: number;
  /** Texto do tooltip e da tabela acessível ("14/09 · 3 pedidos · R$ 420,00"). */
  detail: string;
};

/** Teto "redondo" do eixo: 7 → 10, 1.234 → 2.000, 61 → 100. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

const TICKS = [0, 1 / 3, 2 / 3, 1];

/**
 * Gráfico de colunas de uma série: colunas finas (≤ 24 px) com o topo
 * arredondado e a base reta, grade discreta, rótulo direto só no maior valor
 * e tooltip por coluna (hover e foco) sem JavaScript. Valores também numa
 * tabela só para leitores de tela.
 */
export function BarChart({
  points,
  height = 160,
  formatTick,
  ariaLabel,
  className,
}: {
  points: BarChartPoint[];
  height?: number;
  formatTick: (value: number) => string;
  ariaLabel: string;
  className?: string;
}) {
  const rawMax = Math.max(...points.map((point) => point.value), 0);
  const top = niceMax(rawMax);
  const maxIndex = rawMax > 0 ? points.findIndex((point) => point.value === rawMax) : -1;

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div role="img" aria-label={ariaLabel} className="flex gap-3">
        <div className="relative flex-1" style={{ height }}>
          {TICKS.map((tick) => (
            <div
              key={tick}
              aria-hidden="true"
              className="absolute inset-x-0 border-t border-zinc-200 dark:border-zinc-800"
              style={{ bottom: `${tick * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-0.5 sm:gap-1">
            {points.map((point, index) => {
              const ratio = point.value > 0 ? Math.max(point.value / top, 0.04) : 0;
              return (
                <div
                  key={`${point.label}-${index}`}
                  tabIndex={0}
                  title={point.detail}
                  className="group relative flex h-full flex-1 items-end justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                >
                  {point.value > 0 ? (
                    <div
                      data-bar
                      className="w-full max-w-6 rounded-t bg-indigo-500 transition-colors group-hover:bg-indigo-400 dark:bg-indigo-400 dark:group-hover:bg-indigo-300"
                      style={{ height: `${(ratio * 100).toFixed(1)}%` }}
                    />
                  ) : null}
                  {index === maxIndex ? (
                    <span
                      data-direct-label
                      className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium text-zinc-700 tabular-nums dark:text-zinc-300"
                      style={{ bottom: `calc(${(ratio * 100).toFixed(1)}% + 4px)` }}
                    >
                      {formatTick(point.value)}
                    </span>
                  ) : null}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {point.detail}
                  </span>
                </div>
              );
            })}
          </div>
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 border-t border-zinc-300 dark:border-zinc-700"
          />
        </div>
        <div
          aria-hidden="true"
          className="relative w-14 shrink-0 text-right text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400"
          style={{ height }}
        >
          {TICKS.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2"
              style={{ bottom: `${tick * 100}%` }}
            >
              {formatTick(top * tick)}
            </span>
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="flex gap-0.5 pr-[calc(3.5rem+0.75rem)] sm:gap-1">
        {points.map((point, index) => (
          <span
            key={`${point.label}-${index}`}
            className={cx(
              "flex-1 truncate text-center text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400",
              index % 2 === 1 && "invisible sm:visible",
            )}
          >
            {point.label}
          </span>
        ))}
      </div>

      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <tbody>
          {points.map((point, index) => (
            <tr key={`${point.label}-${index}`}>
              <th scope="row">{point.label}</th>
              <td>{point.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
