// O selo das datas da cidade na home: "Círio em 28 dias · peça até 29/09
// para chegar pelos Correios". Server Component: recebe o texto pronto
// (services/needed-by.getCitySeal) e desenha com a fita da maison.
import { Ribbon } from "@/components/store/ribbon";
import type { CitySeal } from "@/core/shipping/needed-by";

export function CityDateSeal({ seal }: { seal: CitySeal | null }) {
  if (!seal) return null;
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center" role="note" aria-label={`Data da cidade: ${seal.name}`}>
      <Ribbon variant="static" size="sm" />
      <p className="font-store text-sm tracking-[0.12em] text-ink-700 uppercase">
        <span className="font-medium text-espresso-900">{seal.text}</span>
      </p>
    </div>
  );
}
