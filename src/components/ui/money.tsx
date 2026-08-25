import { formatCentsBRL, type Cents } from "@/lib/money";
import { cx } from "./cx";

type MoneyProps = {
  cents: Cents;
  className?: string;
};

export function Money({ cents, className }: MoneyProps) {
  return <span className={className}>{formatCentsBRL(cents)}</span>;
}

export function MoneyDelta({ cents, className }: MoneyProps) {
  const tone =
    cents > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : cents < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-500 dark:text-zinc-400";
  const text = cents > 0 ? `+${formatCentsBRL(cents)}` : formatCentsBRL(cents);
  return <span className={cx(tone, className)}>{text}</span>;
}
