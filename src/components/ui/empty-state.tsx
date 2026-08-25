import type { ReactNode } from "react";

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
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {title}
      </p>
      {hint ? (
        <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
