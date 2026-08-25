export type OrderTimelineEntry = {
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  createdAt: string;
};

const whenFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : whenFormatter.format(date);
}

export function OrderTimeline({
  history,
  labels,
}: {
  history: OrderTimelineEntry[];
  labels: Record<string, string>;
}) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Sem histórico de status.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-6 border-l border-zinc-200 pl-6 dark:border-zinc-800">
      {history.map((entry, index) => (
        <li key={index} className="relative">
          <span
            aria-hidden
            className="absolute top-1 -left-[1.875rem] h-3 w-3 rounded-full border-2 border-white bg-indigo-500 dark:border-zinc-900"
          />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {labels[entry.toStatus] ?? entry.toStatus}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {formatWhen(entry.createdAt)}
            </p>
          </div>
          {entry.fromStatus ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              antes: {labels[entry.fromStatus] ?? entry.fromStatus}
            </p>
          ) : null}
          {entry.reason ? (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {entry.reason}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
