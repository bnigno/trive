// Stepper de quantidade da sacola: botões de 44px, o "−" nunca desliga
// (na unidade ele retira a peça, e diz isso), a quantidade é um <output>
// anunciado a cada mudança. Sem hooks.
import { cx } from "@/components/ui/cx";

const stepButton =
  "flex h-11 w-11 items-center justify-center rounded-(--radius-hair) font-store text-lg text-ink-700 transition-colors hover:bg-ivory-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

export function QuantityStepper({
  value,
  max,
  itemName,
  onDecrease,
  onIncrease,
  className,
}: {
  value: number;
  max: number;
  itemName: string;
  onDecrease: () => void;
  onIncrease: () => void;
  className?: string;
}) {
  const removes = value <= 1;
  return (
    <div
      className={cx(
        "inline-flex items-center rounded-(--radius-hair) border border-ivory-400",
        className,
      )}
    >
      <button
        type="button"
        onClick={onDecrease}
        aria-label={
          removes
            ? `Retirar ${itemName} da sacola`
            : `Diminuir a quantidade de ${itemName}`
        }
        className={stepButton}
      >
        −
      </button>
      <output
        aria-live="polite"
        className="min-w-8 text-center font-store text-sm font-medium text-ink-900 tabular-nums"
      >
        <span className="sr-only">Quantidade </span>
        {value}
      </output>
      <button
        type="button"
        onClick={onIncrease}
        disabled={value >= max}
        aria-label={`Aumentar a quantidade de ${itemName}`}
        className={stepButton}
      >
        +
      </button>
    </div>
  );
}
