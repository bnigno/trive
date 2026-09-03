// Skeleton da coleção: eyebrow, título serif, fita, busca, trilho de salas e a
// grade de cards pulsando na mesma malha da página real.
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando a coleção"
        className="animate-pulse"
      >
        <div className="h-3 w-16 rounded-(--radius-hair) bg-ivory-200" />
        <div className="mt-4 h-9 w-56 rounded-(--radius-hair) bg-ivory-200 sm:h-10 sm:w-72" />
        <div className="mt-4 h-2 w-24 rounded-(--radius-hair) bg-ivory-300/70" />
        <div className="mt-7 h-10 max-w-md border-b border-ivory-300" />

        <div className="mt-6 flex gap-6 border-b border-ivory-300 py-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-3 w-20 rounded-(--radius-hair) bg-ivory-200"
            />
          ))}
        </div>

        <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50"
            >
              <div className="aspect-(--aspect-product) bg-ivory-150" />
              <div className="space-y-2.5 px-4 py-4">
                <div className="h-3 w-4/5 rounded-(--radius-hair) bg-ivory-200" />
                <div className="h-3 w-2/5 rounded-(--radius-hair) bg-ivory-200" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
