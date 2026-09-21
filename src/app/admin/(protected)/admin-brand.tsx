import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { Wordmark } from "@/components/store/brand/wordmark";
import { cx } from "@/components/ui/cx";

/**
 * A marca no topo da lateral e da barra do celular: monograma em ouro
 * escovado (a versão feita para fundos noir) + letreiro em branco. O nome
 * continua vivo: outro nome nos settings cai no texto, como na vitrine.
 */
export function AdminBrand({
  storeName,
  compact = false,
  className,
}: {
  storeName: string;
  /** Barra do celular: menor e sem a legenda "Painel". */
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href="/admin"
      className={cx(
        "flex items-center gap-3 rounded-md text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/60",
        className,
      )}
    >
      <Monogram tone="gold" size={compact ? 26 : 32} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <Wordmark height={compact ? 11 : 13} className="text-white">
          {storeName}
        </Wordmark>
        {compact ? null : (
          <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Painel
          </span>
        )}
      </span>
    </Link>
  );
}
