// Reservas gentis e avisos de "voltou" de um cliente ou de uma variação —
// lista com os botões de liberar/cancelar (server actions por formulário).
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatHoldDeadline } from "@/core/stock/holds";
import type { StockAlertView } from "@/services/stock-alerts";
import type { HoldView } from "@/services/stock-holds";

const HOLD_LABEL: Record<string, string> = {
  active: "Ativa",
  expired: "Venceu",
  released: "Liberada",
  converted: "Virou pedido",
};

export function HoldsAndAlerts({
  holds,
  alerts,
  back,
  releaseAction,
  cancelAction,
  showPhone = false,
}: {
  holds: HoldView[];
  alerts: StockAlertView[];
  /** Caminho a revalidar depois da ação. */
  back: string;
  releaseAction: (formData: FormData) => Promise<void>;
  cancelAction: (formData: FormData) => Promise<void>;
  showPhone?: boolean;
}) {
  const openAlerts = alerts.filter((alert) => !alert.notifiedAt && !alert.canceledAt);
  const doneAlerts = alerts.filter((alert) => alert.notifiedAt || alert.canceledAt);
  if (holds.length === 0 && alerts.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Nenhuma reserva gentil nem pedido de aviso por aqui.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      {holds.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Reservas gentis</p>
          <ul className="mt-2 flex flex-col gap-2">
            {holds.map((hold) => (
              <li key={hold.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <div className="min-w-0">
                  <p className="text-zinc-900 dark:text-zinc-100">
                    {hold.quantity}×{" "}
                    <Link href={`/admin/estoque/${hold.variantId}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      {hold.productName}
                    </Link>
                    {hold.variantLabel ? ` (${hold.variantLabel})` : ""}
                    {showPhone ? <span className="text-zinc-500"> · {hold.phoneE164}</span> : null}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {hold.status === "active" ? `até ${formatHoldDeadline(hold.expiresAt)}` : `vencia ${formatHoldDeadline(hold.expiresAt)}`}
                    {" · "}
                    {hold.createdBy === "admin" ? "separada por você" : "segurada pela vendedora"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={hold.status === "active" ? "warning" : hold.status === "converted" ? "success" : "neutral"}>
                    {HOLD_LABEL[hold.status] ?? hold.status}
                  </Badge>
                  {hold.status === "active" ? (
                    <form action={releaseAction}>
                      <input type="hidden" name="holdId" value={hold.id} />
                      <input type="hidden" name="back" value={back} />
                      <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                        Liberar
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {alerts.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Avisos de “voltou”</p>
          <ul className="mt-2 flex flex-col gap-2">
            {[...openAlerts, ...doneAlerts].map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <div className="min-w-0">
                  <p className="text-zinc-900 dark:text-zinc-100">
                    <Link href={`/admin/estoque/${alert.variantId}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      {alert.productName}
                    </Link>
                    {alert.variantLabel ? ` (${alert.variantLabel})` : ""}
                    {showPhone ? <span className="text-zinc-500"> · {alert.phoneE164}</span> : null}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    pedido {alert.source === "site" ? "na vitrine" : alert.source === "lia" ? "à vendedora" : "por você"}
                    {alert.notifiedAt ? " · avisada" : alert.canceledAt ? " · cancelado" : " · aguardando a peça voltar"}
                  </p>
                </div>
                {!alert.notifiedAt && !alert.canceledAt ? (
                  <form action={cancelAction}>
                    <input type="hidden" name="alertId" value={alert.id} />
                    <input type="hidden" name="back" value={back} />
                    <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <Badge tone={alert.notifiedAt ? "success" : "neutral"}>{alert.notifiedAt ? "Avisada" : "Cancelado"}</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
