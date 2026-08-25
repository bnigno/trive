// Skeleton da vitrine (home): blocos pulsando na mesma malha do layout
// enquanto o servidor monta a página.
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div aria-busy="true" aria-label="Carregando a loja" className="animate-pulse">
        {/* Hero centrado */}
        <div className="flex flex-col items-center gap-4 py-14 text-center sm:py-20">
          <div className="h-10 w-56 rounded bg-zinc-200 sm:h-12 sm:w-72 dark:bg-zinc-800" />
          <div className="h-px w-20 bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-6 w-72 max-w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-2 h-11 w-40 rounded-full bg-zinc-200 dark:bg-zinc-800" />
        </div>

        {/* Grade de produtos */}
        <div className="pb-4">
          <div className="mb-5 h-8 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="aspect-square bg-zinc-200 dark:bg-zinc-800" />
                <div className="space-y-2 p-3">
                  <div className="h-4 w-4/5 rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-4 w-2/5 rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
