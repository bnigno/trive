import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cx } from "./cx";

export type TrendDirection = "up" | "down" | "flat";

export type DayComparisonResult = {
  direction: TrendDirection;
  /** Texto pronto: "+25% vs. ontem", "+3 vs. ontem", "— vs. ontem". */
  label: string;
};

/**
 * Compara hoje com ontem. Com base zero não existe percentual: mostra a
 * diferença absoluta quando há movimento hoje e "—" quando não há.
 */
export function compareDays(
  today: number,
  yesterday: number,
  format: (value: number) => string = (value) => String(value),
): DayComparisonResult {
  if (yesterday <= 0) {
    if (today > 0) return { direction: "up", label: `+${format(today)} vs. ontem` };
    return { direction: "flat", label: "— vs. ontem" };
  }
  const percent = Math.round(((today - yesterday) / yesterday) * 100);
  if (percent === 0) return { direction: "flat", label: "igual a ontem" };
  const sign = percent > 0 ? "+" : "−";
  return {
    direction: percent > 0 ? "up" : "down",
    label: `${sign}${Math.abs(percent)}% vs. ontem`,
  };
}

const ICONS: Record<TrendDirection, typeof TrendingUp> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
};

export function TrendBadge({
  today,
  yesterday,
  format,
  positiveIsGood = true,
  className,
}: {
  today: number;
  yesterday: number;
  format?: (value: number) => string;
  /** Falso para métricas em que subir é ruim (fila morta, atrasos). */
  positiveIsGood?: boolean;
  className?: string;
}) {
  const result = compareDays(today, yesterday, format);
  const Icon = ICONS[result.direction];
  const good =
    result.direction === "flat" ? null : (result.direction === "up") === positiveIsGood;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cx(
          "size-3.5",
          good === true && "text-emerald-600 dark:text-emerald-400",
          good === false && "text-red-600 dark:text-red-400",
        )}
        strokeWidth={2}
      />
      {result.label}
    </span>
  );
}
