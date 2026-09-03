// Índice das salas da maison: "Nome ······ n peças", como sumário de revista.
// Usado no estado vazio, no 404 e onde a grade não cabe. Server Component.
import Link from "next/link";

import { cx } from "@/components/ui/cx";
import type { PublicCategory } from "@/services/store-catalog";

export function CategoryIndex({
  categories,
  compact = false,
  className,
}: {
  categories: PublicCategory[];
  compact?: boolean;
  className?: string;
}) {
  if (categories.length === 0) return null;

  return (
    <nav aria-label="Salas da maison" className={cx("w-full", className)}>
      <ol className={cx("mx-auto flex flex-col", compact ? "max-w-sm" : "max-w-xl")}>
        {categories.map((category, index) => (
          <li key={category.id}>
            <Link
              href={`/produtos?categoria=${encodeURIComponent(category.slug)}`}
              className="group flex min-h-11 items-baseline gap-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
            >
              <span className="shrink-0 font-store text-eyebrow text-ink-400 tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className={cx(
                  "shrink-0 font-display font-semibold text-espresso-900 transition-colors duration-300 group-hover:text-gold-800",
                  compact ? "text-lg" : "text-heading",
                )}
              >
                {category.name}
              </span>
              <span
                aria-hidden="true"
                className="mx-1 min-w-4 flex-1 border-b border-dotted border-ink-300/70"
              />
              <span className="shrink-0 font-store text-eyebrow whitespace-nowrap text-rose-700 tabular-nums">
                {category.productCount}{" "}
                {category.productCount === 1 ? "peça" : "peças"}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
