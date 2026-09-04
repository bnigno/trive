// Linha do tempo visual do pedido na página pública /pedido/[token].
// Server Component puro (sem interatividade). Para status cancelado/
// reembolsado o componente não renderiza nada — a página mostra o banner.
import { IconCheck } from "@/components/store/icons";
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

/** Linha entre passos: trilho marfim; concluída ganha preenchimento dourado
 *  que se desenha ao montar (scale-x, origem à esquerda). */
function StepLine({ hidden, filled }: { hidden: boolean; filled: boolean }) {
  return (
    <div
      aria-hidden
      className={cx(
        "relative h-px flex-1 overflow-hidden",
        hidden ? "bg-transparent" : "bg-ivory-300",
      )}
    >
      {!hidden && filled ? (
        <span className="absolute inset-0 origin-left animate-step-fill bg-gold-500 [animation-duration:600ms] motion-reduce:animate-none" />
      ) : null}
    </div>
  );
}

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
      aria-label={`Andamento do pedido, ${STEPS.length} etapas`}
    >
      {STEPS.map((step, index) => {
        const state = stateOf(index);
        const label =
          step.key === "payment" && state === "done" ? "Pago" : step.label;
        return (
          <li
            key={step.key}
            className="flex flex-1 flex-col items-center"
            aria-current={state === "current" ? "step" : undefined}
          >
            <div className="flex w-full items-center">
              <StepLine hidden={index === 0} filled={state !== "upcoming"} />
              <div
                aria-hidden
                className={cx(
                  "relative flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  state === "current" && "bg-ink-950 text-gold-300",
                  state === "done" && "border border-gold-500 bg-ivory-50",
                  state === "upcoming" &&
                    "border border-ivory-300 bg-ivory-50 text-ink-400",
                )}
              >
                {state === "current" ? (
                  <span className="absolute inset-0 animate-step-halo rounded-full ring-4 ring-gold-500/25 motion-reduce:animate-none" />
                ) : null}
                {state === "done" ? (
                  <IconCheck className="h-3.5 w-3.5 text-gold-700" />
                ) : (
                  index + 1
                )}
              </div>
              <StepLine
                hidden={index === STEPS.length - 1}
                filled={stateOf(index + 1) !== "upcoming"}
              />
            </div>
            <span
              className={cx(
                "mt-2.5 px-0.5 text-center text-[11px] leading-tight tracking-[0.08em] lg:text-xs",
                state === "current"
                  ? "font-medium text-ink-900"
                  : state === "done"
                    ? "text-ink-700"
                    : "text-ink-500",
              )}
            >
              {label}
              <span className="sr-only">
                {state === "done"
                  ? ", concluído"
                  : state === "current"
                    ? ", etapa atual"
                    : ", a seguir"}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
