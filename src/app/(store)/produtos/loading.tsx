// Skeleton da edição: capa tipográfica alta, sumário (desktop), busca, cabeço
// de salas e as chapas da grade na mesma malha da página real (rhythmFor).
import { cx } from "@/components/ui/cx";
import { rhythmFor } from "@/lib/editorial-rhythm";

const SKELETON_COUNT = 10;

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div
        aria-busy="true"
        aria-label="Carregando a coleção"
        className="animate-pulse"
      >
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end lg:gap-x-16">
          <div>
            <div className="h-3 w-24 rounded-(--radius-hair) bg-ivory-200" />
            <div className="mt-4 h-12 w-64 rounded-(--radius-hair) bg-ivory-200 sm:h-14 sm:w-80 lg:h-20 lg:w-96" />
            <div className="mt-4 h-2 w-24 rounded-(--radius-hair) bg-ivory-300/70" />
          </div>
          <div className="mt-6 lg:mt-0">
            <div className="hidden space-y-3 lg:block">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-4 w-full rounded-(--radius-hair) bg-ivory-200"
                />
              ))}
            </div>
            <div className="flex max-w-md items-end gap-3 lg:mt-6">
              <div className="h-10 flex-1 border-b border-ivory-300" />
              <div className="h-11 w-24 rounded-(--radius-hair) bg-ivory-200" />
            </div>
          </div>
        </div>

        <div className="mt-8 flex gap-6 border-b border-ivory-300 py-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-3 w-20 rounded-(--radius-hair) bg-ivory-200"
            />
          ))}
        </div>

        <div className="mt-10 grid grid-cols-2 gap-x-3 gap-y-10 sm:grid-cols-3 sm:gap-x-5 lg:mt-14 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-16">
          {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
            <div key={index} className={cx(rhythmFor(index, SKELETON_COUNT).className)}>
              <div className="aspect-(--aspect-product) rounded-(--radius-hair) border border-ivory-300 bg-ivory-150" />
              <div className="space-y-2.5 border-b border-ivory-300 py-3">
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
