// Esqueleto da sacola enquanto o carrinho hidrata do localStorage (evita
// piscar "sacola vazia" para quem tem peças salvas). Mesma malha da página.
export function CartSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando sua sacola"
        className="animate-pulse"
      >
        <div className="h-3 w-24 rounded-(--radius-hair) bg-ivory-200" />
        <div className="mt-4 h-10 w-48 rounded-(--radius-hair) bg-ivory-200" />
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-x-16">
          <div className="divide-y divide-ivory-300 border-y border-ivory-300">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="flex gap-4 py-6">
                <div className="aspect-(--aspect-product) w-22 rounded-(--radius-hair) bg-ivory-200 sm:w-28" />
                <div className="flex-1 space-y-3">
                  <div className="h-4 w-3/5 rounded-(--radius-hair) bg-ivory-200" />
                  <div className="h-3 w-2/5 rounded-(--radius-hair) bg-ivory-200" />
                  <div className="h-11 w-32 rounded-(--radius-hair) bg-ivory-200" />
                </div>
              </div>
            ))}
          </div>
          <div className="h-80 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50" />
        </div>
      </div>
    </div>
  );
}
