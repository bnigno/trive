import Link from "next/link";
import { cx } from "./cx";

export type FilterPill = {
  label: string;
  href: string;
  active: boolean;
  count?: number;
};

/** Filtros por link (a URL é o estado): a pílula ativa fica "cheia". */
export function FilterPills({
  items,
  "aria-label": ariaLabel,
  className,
}: {
  items: FilterPill[];
  "aria-label": string;
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cx("flex flex-wrap gap-1.5", className)}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "true" : undefined}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40",
            item.active
              ? "border-indigo-600 bg-indigo-600 text-white"
              : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800",
          )}
        >
          {item.label}
          {item.count !== undefined ? (
            <span
              className={cx(
                "tabular-nums",
                item.active ? "text-indigo-100" : "text-zinc-400 dark:text-zinc-500",
              )}
            >
              {item.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
