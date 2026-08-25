import type { ReactNode } from "react";
import type { BadgeTone } from "./badge";
import { cx } from "./cx";

export function Card({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx(
        "rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
    >
      {title ? (
        <h2 className="border-b border-zinc-200 px-5 py-3 text-sm font-semibold text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
          {title}
        </h2>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

const statValueTones: Record<BadgeTone, string> = {
  neutral: "text-zinc-900 dark:text-zinc-100",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
};

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: BadgeTone;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className={cx("mt-1 text-2xl font-semibold", statValueTones[tone])}>
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
}
