// Estado vazio da vitrine — réplica store-only de src/components/ui/empty-state
// (o admin segue usando a versão de ui/). Fita estática + título serif + dica;
// `children` recebe conteúdo extra (ex.: o índice das salas) e `action` o CTA.
import type { ReactNode } from "react";

import { Ribbon } from "@/components/store/ribbon";

export function EmptyState({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-6 py-14 text-center">
      <Ribbon variant="static" size="md" className="mb-2 opacity-70" />
      <p className="font-display text-heading font-semibold text-espresso-900">
        {title}
      </p>
      {hint ? (
        <p className="max-w-md font-store text-sm text-ink-500">{hint}</p>
      ) : null}
      {children ? <div className="mt-4 w-full">{children}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
