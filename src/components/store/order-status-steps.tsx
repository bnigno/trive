// Linha do tempo visual do pedido na página pública /pedido/[token].
// Server Component puro (sem interatividade). Para status cancelado/
// reembolsado o componente não renderiza nada — a página mostra o banner.
import { cx } from "@/components/ui/cx";

const STEPS = [
  { key: "received", label: "Recebido" },
  { key: "payment", label: "Pagamento" },
  { key: "preparing", label: "Separação" },
  { key: "shipped", label: "Enviado" },
  { key: "delivered", label: "Entregue" },
] as const;

/** Índice do passo "atual" para cada status do pedido. */
const CURRENT_STEP_BY_STATUS: Record<string, number> = {
  draft: 0,
  pending_payment: 1,
  paid: 2,
  preparing: 2,
  shipped: 3,
  delivered: 4,
};

type StepState = "done" | "current" | "upcoming";

export function OrderStatusSteps({ status }: { status: string }) {
  const current = CURRENT_STEP_BY_STATUS[status];
  if (current === undefined) return null;

  const allDone = status === "delivered";

  const stateOf = (index: number): StepState => {
    if (allDone || index < current) return "done";
    if (index === current) return "current";
    return "upcoming";
  };

  return (
    <ol
      className="flex items-start"
      aria-label="Andamento do pedido"
    >
      {STEPS.map((step, index) => {
        const state = stateOf(index);
        return (
          <li
            key={step.key}
            className="flex flex-1 flex-col items-center"
            aria-current={state === "current" ? "step" : undefined}
          >
            <div className="flex w-full items-center">
              {/* linha à esquerda do círculo */}
              <div
                aria-hidden
                className={cx(
                  "h-0.5 flex-1 rounded",
                  index === 0
                    ? "bg-transparent"
                    : state === "upcoming"
                      ? "bg-zinc-200 dark:bg-zinc-800"
                      : "bg-amber-700 dark:bg-amber-600",
                )}
              />
              <div
                aria-hidden
                className={cx(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  state === "done" &&
                    "bg-amber-700 text-white dark:bg-amber-600 dark:text-zinc-950",
                  state === "current" &&
                    "bg-amber-700 text-white ring-4 ring-amber-200 dark:bg-amber-600 dark:text-zinc-950 dark:ring-amber-950",
                  state === "upcoming" &&
                    "border border-zinc-300 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500",
                )}
              >
                {state === "done" ? "✓" : index + 1}
              </div>
              {/* linha à direita do círculo */}
              <div
                aria-hidden
                className={cx(
                  "h-0.5 flex-1 rounded",
                  index === STEPS.length - 1
                    ? "bg-transparent"
                    : stateOf(index + 1) === "upcoming"
                      ? "bg-zinc-200 dark:bg-zinc-800"
                      : "bg-amber-700 dark:bg-amber-600",
                )}
              />
            </div>
            <span
              className={cx(
                "mt-2 px-0.5 text-center text-[11px] leading-tight sm:text-xs",
                state === "current"
                  ? "font-semibold text-amber-800 dark:text-amber-400"
                  : state === "done"
                    ? "font-medium text-zinc-700 dark:text-zinc-300"
                    : "text-zinc-400 dark:text-zinc-500",
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
