// Skeleton da listagem de produtos: eyebrow, título serif, rail de categorias
// e a grade de cards pulsando na mesma malha da página real.
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando os produtos"
        className="animate-pulse"
      >
        {/* Eyebrow (contagem) + título */}
        <div className="h-3 w-20 rounded-(--radius-hair) bg-ivory-200/80" />
        <div className="mt-4 h-9 w-64 rounded-(--radius-hair) bg-ivory-200/80 sm:h-10 sm:w-80" />

        {/* Rail tipográfico de categorias */}
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="h-3 w-20 rounded-(--radius-hair) bg-ivory-200/80"
            />
          ))}
        </div>

        {/* Grade de cards */}
        <div className="mt-10 grid grid-cols-2 gap-x-5 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50"
            >
              <div className="aspect-square bg-ivory-200/80" />
              <div className="space-y-2.5 px-4 py-4">
                <div className="h-3 w-4/5 rounded-(--radius-hair) bg-ivory-200/80" />
                <div className="h-3 w-2/5 rounded-(--radius-hair) bg-ivory-200/80" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
