import { cx } from "./cx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        "animate-pulse rounded-md bg-zinc-200/80 motion-reduce:animate-none dark:bg-zinc-800",
        className,
      )}
    />
  );
}

/** Um cartão "carregando" com a mesma moldura do <Card>. */
export function CardSkeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        "rounded-xl border border-zinc-200/80 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
    >
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 flex flex-col gap-2.5">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={index % 2 === 0 ? "h-3 w-full" : "h-3 w-4/5"} />
        ))}
      </div>
    </div>
  );
}
