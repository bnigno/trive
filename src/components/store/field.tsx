// Campo de formulário da vitrine — réplica store-only do Field de
// src/components/ui/form (o admin segue usando a versão de ui/; mesma API).
// O <label> envolve o controle (sem htmlFor/id). Se um dia virar htmlFor/id,
// ligue hint e erro por aria-describedby.
import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";

export function Field({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="font-store text-[11px] font-medium uppercase tracking-[0.14em] text-ink-700">
        {label}
      </span>
      {children}
      {hint && !error ? (
        <span className="text-xs text-ink-500">{hint}</span>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-claret-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}
