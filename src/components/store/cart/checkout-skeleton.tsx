// Esqueleto do checkout enquanto o carrinho hidrata: resumo + formulário na
// mesma malha da página real.
export function CheckoutSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando o checkout"
        className="animate-pulse"
      >
        <div className="h-3 w-28 rounded-(--radius-hair) bg-ivory-200" />
        <div className="mt-4 h-10 w-56 rounded-(--radius-hair) bg-ivory-200" />
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-x-16">
          <div className="space-y-8">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="border-t border-ivory-300 pt-6">
                <div className="h-5 w-40 rounded-(--radius-hair) bg-ivory-200" />
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div className="h-11 border-b border-ivory-300" />
                  <div className="h-11 border-b border-ivory-300" />
                </div>
              </div>
            ))}
          </div>
          <div className="h-72 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 lg:order-first lg:col-start-2 lg:row-start-1" />
        </div>
      </div>
    </div>
  );
}
