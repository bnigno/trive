// Índice das salas da maison: "Nome ······ n peças", como sumário de revista.
// Usado no estado vazio, no 404, no sumário da coleção e onde a grade não
// cabe. Server Component.
import Link from "next/link";

import { cx } from "@/components/ui/cx";
import type { PublicCategory } from "@/services/store-catalog";

const linkClass =
  "group flex min-h-11 items-baseline gap-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

function Row({
  href,
  numeral,
  name,
  count,
  active,
  compact,
}: {
  href: string;
  numeral: string;
  name: string;
  count: number;
  active: boolean;
  compact: boolean;
}) {
  return (
    <li>
      <Link href={href} className={linkClass} aria-current={active ? "page" : undefined}>
        <span
          className={cx(
            "w-5 shrink-0 font-store text-eyebrow tabular-nums",
            active ? "text-gold-800" : "text-ink-500",
          )}
        >
          {numeral}
        </span>
        <span
          className={cx(
            "shrink-0 font-display font-semibold text-espresso-900 transition-colors duration-300 group-hover:text-gold-800",
            compact ? "text-lg" : "text-heading",
            active && "underline decoration-gold-500 decoration-2 underline-offset-4",
          )}
        >
          {name}
        </span>
        <span
          aria-hidden="true"
          className="mx-1 min-w-4 flex-1 border-b border-dotted border-ink-300/70"
        />
        <span className="shrink-0 font-store text-eyebrow whitespace-nowrap text-rose-700 tabular-nums">
          {count} {count === 1 ? "peça" : "peças"}
        </span>
      </Link>
    </li>
  );
}

export function CategoryIndex({
  categories,
  compact = false,
  activeSlug = null,
  includeAll = false,
  ariaLabel = "Salas da maison",
  className,
}: {
  categories: PublicCategory[];
  compact?: boolean;
  /** Sala aberta (aria-current + sublinhado dourado). */
  activeSlug?: string | null;
  /** Prepende "Toda a coleção" com o total de peças. */
  includeAll?: boolean;
  /** Rótulo do landmark — mude quando houver outro <nav> de salas na página. */
  ariaLabel?: string;
  className?: string;
}) {
  if (categories.length === 0) return null;
  const total = categories.reduce((sum, category) => sum + category.productCount, 0);

  return (
    <nav aria-label={ariaLabel} className={cx("w-full", className)}>
      <ol className={cx("mx-auto flex flex-col", compact ? "max-w-sm" : "max-w-xl")}>
        {includeAll ? (
          <Row
            href="/produtos"
            numeral="—"
            name="Toda a coleção"
            count={total}
            active={activeSlug === null}
            compact={compact}
          />
        ) : null}
        {categories.map((category, index) => (
          <Row
            key={category.id}
            href={`/produtos?categoria=${encodeURIComponent(category.slug)}`}
            numeral={String(index + 1).padStart(2, "0")}
            name={category.name}
            count={category.productCount}
            active={activeSlug === category.slug}
            compact={compact}
          />
        ))}
      </ol>
    </nav>
  );
}
