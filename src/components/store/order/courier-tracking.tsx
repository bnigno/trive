"use client";

// "Seu motoboy" na página do pedido: o mapa com o motoboy chegando e a
// leitura em palavras (a caminho · 2,1 km · ~8 min / chegando / sem sinal).
// Pergunta ao servidor a cada 5 s (setTimeout ENCADEADO, nunca setInterval;
// pausa com a aba escondida; para nos estados finais). Sem regra aqui: a
// leitura vem pronta do core pela rota /pedido/<token>/rastreio.
import { useEffect, useState } from "react";

import { isTrackingFinal, trackingViewJsonSchema, type TrackingViewJson } from "@/core/delivery/tracking-json";
import { distanceLabel } from "@/core/delivery/tracking";
import { LiveMap } from "@/components/ui/live-map";
import { btnOutline } from "@/components/store/styles";

const POLL_MS = 5_000;
const POLL_WAITING_MS = 15_000;
const POLL_ERROR_MS = 20_000;
/** Raio da área quando a posição vem arredondada (~110 m de célula). */
const APPROX_RADIUS_M = 120;

export function CourierTracking({ token, initial, storeWhatsappUrl }: { token: string; initial: TrackingViewJson; storeWhatsappUrl: string | null }) {
  const [view, setView] = useState<TrackingViewJson>(initial);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (isTrackingFinal(initial.state)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;
    const controller = new AbortController();
    const schedule = (ms: number) => {
      if (stopped) return;
      timer = setTimeout(poll, ms);
    };
    const poll = async () => {
      if (document.hidden) {
        schedule(POLL_MS);
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/pedido/${token}/rastreio`, { cache: "no-store", signal: controller.signal });
        // 404 = a saída foi cancelada pela loja (a parada sumiu): estado final, sem mais perguntas.
        if (response.status === 404) {
          setView((current) => ({ ...current, state: "finished", courier: null, distanceKm: null, etaMinutes: null }));
          setOffline(false);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = trackingViewJsonSchema.parse(await response.json());
        setView(parsed);
        setOffline(false);
        if (isTrackingFinal(parsed.state)) return;
        schedule(parsed.state === "waiting" ? POLL_WAITING_MS : POLL_MS);
      } catch {
        if (controller.signal.aborted) return;
        setOffline(true);
        schedule(POLL_ERROR_MS);
      } finally {
        inFlight = false;
      }
    };
    const onVisible = () => {
      if (!document.hidden && !stopped && !inFlight) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(initial.state === "waiting" ? POLL_WAITING_MS : POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, initial.state]);

  const name = view.courierFirstName;
  const showMap = (view.state === "en_route" || view.state === "arriving") && view.courier !== null;

  return (
    <div className="mt-3 flex flex-col gap-4">
      <Headline view={view} />
      {showMap && view.courier ? (
        <LiveMap
          courier={{ lat: view.courier.lat, lng: view.courier.lng, radiusM: view.approximate ? Math.max(APPROX_RADIUS_M, view.courier.accuracyM ?? 0) : view.courier.accuracyM }}
          follow
          className="relative z-0 isolate h-64 w-full overflow-hidden rounded-(--radius-hair) border border-ivory-300 sm:h-80"
          ariaLabel={`Mapa com a posição de ${name}`}
        />
      ) : null}
      <SignalLine view={view} offline={offline} />
      {storeWhatsappUrl && !isTrackingFinal(view.state) ? (
        <a href={storeWhatsappUrl} target="_blank" rel="noopener noreferrer" className={`${btnOutline} self-start`}>
          Falar com a TRIVÉ
        </a>
      ) : null}
    </div>
  );
}

function Headline({ view }: { view: TrackingViewJson }) {
  const name = view.courierFirstName;
  const base = "font-display text-heading font-semibold text-espresso-900";
  if (view.state === "waiting") return <p className={base}>{name} está saindo da TRIVÉ com o seu pedido.</p>;
  if (view.state === "arriving") return <p className={base}>{name} está chegando!</p>;
  if (view.state === "delivered") {
    return (
      <p className={base}>
        Entregue{view.receivedBy ? `, recebido por ${view.receivedBy}` : ""}. 🤎
      </p>
    );
  }
  if (view.state === "failed") return <p className={base}>{name} não conseguiu entregar desta vez — a TRIVÉ vai falar com você pelo WhatsApp para combinar.</p>;
  if (view.state === "finished") return <p className={base}>A saída do motoboy foi encerrada. Qualquer dúvida, fale com a TRIVÉ.</p>;
  const parts: string[] = [];
  if (view.distanceKm !== null) parts.push(`a ${distanceLabel(view.distanceKm)} de você`);
  if (view.etaMinutes !== null) parts.push(`chega em ~${view.etaMinutes} min`);
  return (
    <p className={base}>
      {name} está a caminho{parts.length ? ` — ${parts.join(" · ")}` : ""}.
      {view.otherStopsPending > 0 ? <span className="block font-store text-sm font-normal text-ink-700">Tem mais {view.otherStopsPending === 1 ? "uma entrega" : `${view.otherStopsPending} entregas`} nesta saída — pode passar em outra cliente antes.</span> : null}
    </p>
  );
}

function SignalLine({ view, offline }: { view: TrackingViewJson; offline: boolean }) {
  if (isTrackingFinal(view.state) || view.state === "waiting") return null;
  const minutes = view.updatedSecondsAgo !== null ? Math.round(view.updatedSecondsAgo / 60) : null;
  let text: string;
  if (view.signal === "none") text = "Esperando o primeiro sinal do GPS…";
  else if (view.signal === "lost") text = `Sem sinal do motoboy há ${minutes} min — ele pode estar sem internet; a entrega segue normalmente.`;
  else if (view.signal === "stale") text = `Última posição há ${minutes} min.`;
  else text = view.approximate ? "Posição aproximada, ao vivo." : "Posição ao vivo.";
  return (
    <p className="font-store text-xs text-ink-500">
      {text}
      {offline ? " Sua internet oscilou — tentando de novo." : ""}
    </p>
  );
}
