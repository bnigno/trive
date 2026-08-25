// Skeleton da listagem de produtos: título, chips de categoria e a grade de
// cards pulsando na mesma malha da página real.
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando os produtos"
        className="animate-pulse"
      >
        {/* Título + contagem */}
        <div className="h-8 w-64 rounded bg-zinc-200 sm:h-9 dark:bg-zinc-800" />
        <div className="mt-2 h-4 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />

        {/* Chips de categoria */}
        <div className="mt-5 flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="h-8 w-24 rounded-full bg-zinc-200 dark:bg-zinc-800"
            />
          ))}
        </div>

        {/* Grade de cards */}
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
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
  );
}
