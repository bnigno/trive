"use client";

// O mapa ao vivo da saída no painel: o motoboy (posição exata), os pinos das
// paradas geocodificadas (numerados; cor pelo status) e a trilha. Pergunta a
// cada 5 s enquanto a saída está aberta (setTimeout encadeado, pausa com a
// aba escondida) e depois recarrega a página quando o status muda.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { LiveMap } from "@/components/ui/live-map";
import { signalAgeLabel } from "@/core/delivery/positions";

import { runLiveSchema, type RunLive } from "./poll/schema";

const POLL_MS = 5_000;
const POLL_ERROR_MS = 20_000;

const noop = () => () => {};
/** Só no cliente: o "há N min" não pode nascer no HTML do servidor (hidratação divergente). */
function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

function stopsKey(live: RunLive): string {
  return live.stops.map((s) => `${s.sequence}:${s.status}`).join(",");
}

export function RunLiveMap({ runId, initial }: { runId: string; initial: RunLive }) {
  const router = useRouter();
  const [live, setLive] = useState<RunLive>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [sessionLost, setSessionLost] = useState(false);
  const mounted = useMounted();
  const keyRef = useRef(`${initial.status}|${stopsKey(initial)}`);
  const open = live.status === "ready" || live.status === "en_route";

  useEffect(() => {
    if (!(initial.status === "ready" || initial.status === "en_route")) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const controller = new AbortController();
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(poll, ms);
    };
    const poll = async () => {
      if (document.hidden) {
        schedule(POLL_MS);
        return;
      }
      try {
        const response = await fetch(`/admin/pedidos/saidas/${runId}/poll`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          setSessionLost(true);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = runLiveSchema.parse(await response.json());
        setLive(parsed);
        setNow(Date.now());
        // Status da saída OU de uma parada mudou: a lista e os botões (RSC) recarregam.
        const key = `${parsed.status}|${stopsKey(parsed)}`;
        if (key !== keyRef.current) {
          keyRef.current = key;
          router.refresh();
        }
        if (parsed.status === "finished" || parsed.status === "canceled") return;
        schedule(POLL_MS);
      } catch {
        if (!controller.signal.aborted) schedule(POLL_ERROR_MS);
      }
    };
    schedule(POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [runId, initial.status, router]);

  const pins = live.stops.flatMap((stop) => {
    const point = stop.deliveredPoint ?? stop.destination;
    if (!point) return [];
    const tone = stop.status === "delivered" ? ("done" as const) : stop.status === "failed" ? ("failed" as const) : stop.status === "canceled" ? ("muted" as const) : ("pending" as const);
    return [{ ...point, label: String(stop.sequence), tone }];
  });
  const withoutPin = live.stops.filter((stop) => !stop.destination && !stop.deliveredPoint).map((stop) => stop.sequence);
  const seenAt = live.lastPosition ? new Date(live.lastPosition.seenAt) : null;

  return (
    <div className="flex flex-col gap-2">
      <LiveMap
        courier={live.lastPosition && open ? { lat: live.lastPosition.lat, lng: live.lastPosition.lng, radiusM: live.lastPosition.accuracyM } : null}
        pins={pins}
        trail={live.trail}
        follow={open}
        fallbackCenter={live.lastPosition ?? pins[0] ?? undefined}
        className="relative z-0 isolate h-80 w-full overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
        ariaLabel="Mapa da saída"
      />
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {sessionLost ? "Sessão expirada — recarregue a página para voltar a acompanhar. " : ""}
        {seenAt ? (mounted ? `Última posição ${signalAgeLabel(seenAt, new Date(now))}` : "Última posição …") : "Sem posição ainda"}
        {live.lastPosition?.accuracyM ? ` (±${Math.round(live.lastPosition.accuracyM)} m)` : ""}
        {" · "}pinos: {pins.length} de {live.stops.length} paradas
        {withoutPin.length ? ` — sem endereço no mapa: ${withoutPin.map((n) => `#${n}`).join(", ")} (geocodificação em andamento ou endereço sem cobertura)` : ""}
      </p>
    </div>
  );
}
