// Estado vazio da vitrine — réplica store-only de src/components/ui/empty-state
// (o admin segue usando a versão de ui/; mesma API, visual boutique).
import type { ReactNode } from "react";

import { Monogram } from "@/components/store/brand/monogram";

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-6 py-14 text-center">
      <Monogram size={56} className="opacity-20" />
      <p className="font-display text-heading text-ink-900">{title}</p>
      {hint ? (
        <p className="max-w-md font-store text-sm text-ink-500">{hint}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
