// Card "Tempo de resposta da Lia": mediana e p90 de mensagem → primeiro
// balão, e onde o tempo foi (fila · preparo · modelo · entrega). Só
// apresenta o que services/wa-insights mede a partir do audit dos turnos.
import type { BotResponseTimes, BotTimingSplit } from "@/services/wa-insights";

const SEGMENTS: ReadonlyArray<{ key: keyof BotTimingSplit; label: string; className: string }> = [
  { key: "queueWaitMs", label: "fila", className: "bg-zinc-400 dark:bg-zinc-500" },
  { key: "prepMs", label: "preparo", className: "bg-sky-400" },
  { key: "modelMs", label: "modelo", className: "bg-violet-500" },
  { key: "deliveryMs", label: "entrega", className: "bg-emerald-500" },
];

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: ms < 10_000 ? 1 : 0 })} s`;
}

export function ResponseTimes({ times, sellerName }: { times: BotResponseTimes; sellerName: string }) {
  if (times.turns === 0) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Assim que a {sellerName} responder algumas clientes, aparece aqui quanto tempo ela levou — e onde o tempo foi.
      </p>
    );
  }
  const split = times.p50;
  const total = SEGMENTS.reduce((sum, segment) => sum + (split[segment.key] ?? 0), 0);
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Da mensagem ao primeiro balão (mediana)</dt>
          <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{seconds(times.p50.inboundToFirstBubbleMs)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Nas 10% mais lentas (p90)</dt>
          <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{seconds(times.p90.inboundToFirstBubbleMs)}</dd>
        </div>
      </dl>
      {total > 0 ? (
        <div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden="true">
            {SEGMENTS.map((segment) => {
              const value = split[segment.key] ?? 0;
              return value > 0 ? (
                <span key={segment.key} className={segment.className} style={{ width: `${(value / total) * 100}%` }} />
              ) : null;
            })}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
            {SEGMENTS.map((segment) => (
              <li key={segment.key} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${segment.className}`} />
                {segment.label} {seconds(split[segment.key])}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Medianas de {times.turns} {times.turns === 1 ? "resposta" : "respostas"} em {times.windowDays} dias. Fila é o tempo entre a mensagem chegar e a {sellerName} começar; modelo inclui as ferramentas (catálogo, frete, pedido).
      </p>
    </div>
  );
}
