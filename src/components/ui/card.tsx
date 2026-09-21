import Link from "next/link";
import type { ReactNode } from "react";
import type { BadgeTone } from "./badge";
import { cx } from "./cx";
import { Sparkline } from "./sparkline";

export const cardSurfaceClasses =
  "rounded-xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none";

export function Card({
  id,
  title,
  description,
  action,
  padding = "md",
  className,
  children,
}: {
  /** Âncora (#id) para links que levam direto ao bloco. */
  id?: string;
  title?: string;
  description?: string;
  /** Canto direito do cabeçalho: um link "Ver todos", um botão. */
  action?: ReactNode;
  /** "none" para tabelas e listas que encostam na moldura. */
  padding?: "md" | "none";
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cx(cardSurfaceClasses, className)}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-200/80 px-5 py-3 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="flex items-center gap-2 text-sm">{action}</div> : null}
        </div>
      ) : null}
      <div className={padding === "none" ? undefined : "p-5"}>{children}</div>
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

const statIconTones: Record<BadgeTone, string> = {
  neutral: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  success: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400",
  warning: "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400",
  danger: "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400",
  info: "bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-400",
};

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  delta,
  trend,
  href,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: BadgeTone;
  /** Ícone lucide (size-4); ganha um fundo discreto no tom do card. */
  icon?: ReactNode;
  /** Comparação ("+12% vs. ontem"): normalmente um <TrendBadge>. */
  delta?: ReactNode;
  /** Últimos N valores para a linha de tendência no canto. */
  trend?: number[];
  /** Com href o card inteiro é um link. */
  href?: string;
  className?: string;
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
        {icon ? (
          <span
            aria-hidden="true"
            className={cx(
              "inline-grid size-8 shrink-0 place-items-center rounded-lg",
              statIconTones[tone],
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className={cx("text-2xl font-semibold tracking-tight", statValueTones[tone])}>
          {value}
        </p>
        {trend && trend.length > 1 ? (
          <Sparkline
            values={trend}
            className="mb-1 text-indigo-500 dark:text-indigo-400"
          />
        ) : null}
      </div>
      {delta ? <div className="mt-1.5">{delta}</div> : null}
      {hint ? (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </>
  );

  const surface = cx(cardSurfaceClasses, "block px-5 py-4", className);

  if (href) {
    return (
      <Link
        href={href}
        className={cx(
          surface,
          "transition hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 motion-reduce:transform-none motion-reduce:transition-none",
        )}
      >
        {content}
      </Link>
    );
  }
  return <div className={surface}>{content}</div>;
}
