// Skeleton da vitrine (home): blocos marfim pulsando na mesma malha do
// layout enquanto o servidor monta a página.
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando a loja"
        className="animate-pulse"
      >
        {/* Hero centrado */}
        <div className="flex flex-col items-center gap-5 py-16 text-center sm:py-24">
          <div className="h-4 w-20 rounded-(--radius-hair) bg-ivory-200/80" />
          <div className="h-12 w-64 rounded-(--radius-hair) bg-ivory-200/80 sm:h-16 sm:w-80" />
          <div className="h-px w-28 bg-ivory-300" />
          <div className="h-6 w-72 max-w-full rounded-(--radius-hair) bg-ivory-200/80" />
          <div className="mt-3 h-12 w-44 rounded-(--radius-hair) bg-ivory-200/80" />
        </div>

        {/* Faixa de benefícios */}
        <div className="grid gap-px border-y border-ivory-300 py-10 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="mx-auto h-20 w-56 max-w-full rounded-(--radius-hair) bg-ivory-200/80"
            />
          ))}
        </div>

        {/* Grade de produtos */}
        <div className="py-14">
          <div className="mb-8 h-9 w-44 rounded-(--radius-hair) bg-ivory-200/80" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50"
              >
                <div className="aspect-square bg-ivory-200/80" />
                <div className="space-y-2 p-3">
                  <div className="h-4 w-4/5 rounded-(--radius-hair) bg-ivory-200/80" />
                  <div className="h-4 w-2/5 rounded-(--radius-hair) bg-ivory-200/80" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
