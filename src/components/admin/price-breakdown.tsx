import type { PriceBreakdown } from "@/core/pricing/types";
import { Money } from "@/components/ui/money";

const factorFormatter = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const percentFormatter = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function SummaryRow({
  label,
  children,
  emphasis = false,
}: {
  label: string;
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt
        className={
          emphasis
            ? "text-sm font-medium text-zinc-900 dark:text-zinc-100"
            : "text-sm text-zinc-600 dark:text-zinc-400"
        }
      >
        {label}
      </dt>
      <dd
        className={
          emphasis
            ? "text-right font-semibold text-zinc-900 tabular-nums dark:text-zinc-100"
            : "text-right text-sm text-zinc-900 tabular-nums dark:text-zinc-100"
        }
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * A "conta aberta" de um preço: cada passo do cálculo, linha a linha,
 * e o resultado final — pensado para quem não é da área financeira.
 */
export function PriceBreakdownView({
  breakdown,
  className,
}: {
  breakdown: PriceBreakdown;
  className?: string;
}) {
  return (
    <section
      className={[
        "rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          A conta, linha a linha
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Como este preço foi calculado, passo a passo.
        </p>
      </div>

      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {breakdown.steps.map((step, index) => (
          <div
            key={index}
            className="flex items-baseline justify-between gap-4 px-5 py-2.5"
          >
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              {step.label}
            </dt>
            <dd className="text-right text-sm text-zinc-900 tabular-nums dark:text-zinc-100">
              {step.valueCents != null ? (
                <Money cents={step.valueCents} />
              ) : step.value != null ? (
                factorFormatter.format(step.value)
              ) : (
                "—"
              )}
            </dd>
          </div>
        ))}
      </dl>

      <dl className="flex flex-col gap-2.5 border-t border-zinc-200 bg-zinc-50 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-800/40">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Preço final
          </dt>
          <dd className="text-right text-2xl font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">
            <Money cents={breakdown.output.priceCents} />
          </dd>
        </div>
        <SummaryRow label="Margem efetiva">
          {percentFormatter.format(breakdown.output.effectiveMarginRate)}{" "}
          <span className="text-zinc-500 dark:text-zinc-400">
            (<Money cents={breakdown.output.effectiveMarginCents} />)
          </span>
        </SummaryRow>
        <SummaryRow label="Taxa estimada do gateway">
          <Money cents={breakdown.output.feeEstimatedCents} />
        </SummaryRow>
        <SummaryRow label="Valor líquido a receber" emphasis>
          <Money cents={breakdown.output.netReceivableCents} />
        </SummaryRow>
      </dl>
    </section>
  );
}
