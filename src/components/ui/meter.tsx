import { cx } from "./cx";

export type MeterTone = "accent" | "success" | "warning" | "danger";

// Trilho = passo mais claro do mesmo tom, para o estado ler na barra inteira.
const toneClasses: Record<MeterTone, { track: string; fill: string }> = {
  accent: {
    track: "bg-indigo-100 dark:bg-indigo-950/60",
    fill: "bg-indigo-500 dark:bg-indigo-400",
  },
  success: {
    track: "bg-emerald-100 dark:bg-emerald-950/60",
    fill: "bg-emerald-500 dark:bg-emerald-400",
  },
  warning: {
    track: "bg-amber-100 dark:bg-amber-950/60",
    fill: "bg-amber-500 dark:bg-amber-400",
  },
  danger: {
    track: "bg-red-100 dark:bg-red-950/60",
    fill: "bg-red-500 dark:bg-red-400",
  },
};

export function Meter({
  value,
  max,
  tone = "accent",
  label,
  size = "md",
  className,
}: {
  value: number;
  max: number;
  tone?: MeterTone;
  /** Nome do que a barra mede, para leitores de tela. */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const classes = toneClasses[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      className={cx(
        "w-full overflow-hidden rounded-full",
        size === "sm" ? "h-1.5" : "h-2",
        classes.track,
        className,
      )}
    >
      <div
        className={cx("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", classes.fill)}
        style={{ width: `${(ratio * 100).toFixed(1)}%` }}
      />
    </div>
  );
}
