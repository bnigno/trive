"use client";

// A página do motoboy: "Comecei a rota" liga o GPS (watchPosition + tela
// acesa) e manda a posição ao servidor a cada 5 s / 10 m; cada parada tem
// navegação, ligar, WhatsApp, "Entregue" (quem recebeu) e "Não consegui".
// Sem regra de negócio: a decisão de mandar ou não uma amostra é do core
// (shouldSendSample); o resto é o service, pelas actions.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";

import { shouldSendSample, type PositionSample } from "@/core/delivery/positions";
import { FAILURE_REASON_LABELS, FAILURE_REASONS, RUN_STATUS_LABELS, type FailureReason } from "@/core/delivery/state";
import { formatCentsBRL } from "@/lib/money";
import { waMeUrl } from "@/lib/phone";

import { completeStopAction, failStopAction, finishRunAction, startRunAction, type CourierActionResult } from "./actions";
import type { CourierRunProps } from "./page";

type Fix = PositionSample & { speedMps: number | null };
type GpsState = "off" | "on" | "denied" | "unsupported" | "error";
/** O que a tela mostra: "starting" enquanto o GPS ligado ainda não deu a primeira amostra. */
type GpsDisplay = GpsState | "starting";

const QUEUE_MAX = 50;
const BIG_BUTTON = "flex min-h-14 w-full items-center justify-center gap-2 rounded-(--radius-soft) px-5 text-base font-semibold transition-colors disabled:opacity-50";
const LINK_BUTTON = "flex min-h-12 flex-1 items-center justify-center rounded-(--radius-soft) border border-ivory-400 bg-ivory-50 px-3 text-sm font-medium text-ink-900 active:bg-ivory-200";

function positionBody(fix: Fix): string {
  return JSON.stringify({ lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, speedMps: fix.speedMps, recordedAt: fix.recordedAt.toISOString() });
}

/**
 * O GPS do celular → servidor. watchPosition enquanto `active`; amostras
 * filtradas por shouldSendSample; falha de rede vira fila (até 50) que
 * esvazia na amostra seguinte ou quando a internet volta; ao fechar a
 * aba, a última posição sai por sendBeacon. Wake Lock mantém a tela acesa.
 */
function useGpsTracking(token: string, active: boolean) {
  const [gps, setGps] = useState<GpsState>("off");
  const [lastFix, setLastFix] = useState<Fix | null>(null);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const [sendFailures, setSendFailures] = useState(0);
  const lastSentRef = useRef<PositionSample | null>(null);
  const lastFixRef = useRef<Fix | null>(null);
  const queueRef = useRef<string[]>([]);
  const sendingRef = useRef(false);
  const watchRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const url = `/entrega/${token}/posicao`;

  const flush = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const body = queueRef.current[0];
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, cache: "no-store" });
        if (!response.ok && response.status !== 400) throw new Error(`HTTP ${response.status}`);
        queueRef.current.shift();
        setLastSentAt(new Date());
        setSendFailures(0);
      }
    } catch {
      setSendFailures((n) => n + 1);
    } finally {
      sendingRef.current = false;
    }
  }, [url]);

  const enqueue = useCallback(
    (fix: Fix) => {
      queueRef.current.push(positionBody(fix));
      if (queueRef.current.length > QUEUE_MAX) queueRef.current.splice(0, queueRef.current.length - QUEUE_MAX);
      void flush();
    },
    [flush],
  );

  const requestWakeLock = useCallback(async () => {
    try {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      if (!wakeLock) return;
      wakeLockRef.current = await wakeLock.request("screen");
    } catch {
      // Sem Wake Lock (iOS antigo, bateria baixa): a tela pode apagar — o aviso na página cobre.
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      const timer = setTimeout(() => setGps("unsupported"), 0);
      return () => clearTimeout(timer);
    }
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const fix: Fix = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          speedMps: position.coords.speed !== null && Number.isFinite(position.coords.speed) ? Math.max(0, position.coords.speed) : null,
          recordedAt: new Date(position.timestamp),
        };
        lastFixRef.current = fix;
        setLastFix(fix);
        setGps("on");
        if (!shouldSendSample(lastSentRef.current, fix)) return;
        lastSentRef.current = fix;
        enqueue(fix);
      },
      (error) => {
        setGps(error.code === error.PERMISSION_DENIED ? "denied" : "error");
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    void requestWakeLock();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
        void flush();
      }
    };
    const onOnline = () => void flush();
    const onPageHide = () => {
      const fix = lastFixRef.current;
      if (!fix || typeof navigator.sendBeacon !== "function") return;
      navigator.sendBeacon(url, new Blob([positionBody(fix)], { type: "application/json" }));
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      void wakeLockRef.current?.release();
      wakeLockRef.current = null;
    };
  }, [active, enqueue, flush, requestWakeLock, url]);

  const display: GpsDisplay = active && gps === "off" ? "starting" : gps;
  return { gps: display, lastFix, lastSentAt, sendFailures };
}

const noop = () => () => {};
/** Só no cliente: no servidor o texto do iPhone não existe (evita hidratação divergente). */
function useIsIos(): boolean {
  return useSyncExternalStore(noop, () => /iPhone|iPad|iPod/i.test(navigator.userAgent), () => false);
}
function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** "há 5 s" / "há 2 min", recalculado a cada segundo enquanto a saída roda. */
function useAgo(at: Date | null, running: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 1_000);
    };
    timer = setTimeout(tick, 1_000);
    return () => clearTimeout(timer);
  }, [running]);
  if (!at) return null;
  const seconds = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (seconds < 60) return `há ${seconds} s`;
  return `há ${Math.round(seconds / 60)} min`;
}

export function CourierRun({ token, view }: { token: string; view: CourierRunProps }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const isIos = useIsIos();
  const online = useOnline();
  const running = view.status === "en_route";
  const { gps, lastFix, lastSentAt, sendFailures } = useGpsTracking(token, running);
  const sentAgo = useAgo(lastSentAt, running);

  const run = (action: () => Promise<CourierActionResult>) => {
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        if (result.message) setNotice({ tone: "ok", text: result.message });
        router.refresh();
      } else {
        setNotice({ tone: "error", text: result.error });
      }
    });
  };

  const pendingStops = view.stops.filter((stop) => stop.status === "pending");
  const doneStops = view.stops.filter((stop) => stop.status !== "pending");
  const position = lastFix ? { lat: lastFix.lat, lng: lastFix.lng, accuracyM: lastFix.accuracyM } : null;

  if (view.status === "finished" || view.status === "canceled") {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <p className="font-store text-eyebrow font-medium uppercase text-ink-500">{view.storeName}</p>
        <h1 className="text-2xl font-semibold">{view.status === "finished" ? "Saída encerrada. Obrigado!" : "Esta saída foi cancelada pela loja."}</h1>
        <p className="text-ink-700">{view.status === "finished" ? "Sua localização parou de ser compartilhada. Boa volta!" : "Fale com a loja pelo WhatsApp se ainda estiver com alguma peça."}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 pt-6 pb-12">
      <header className="flex flex-col gap-1">
        <p className="font-store text-eyebrow font-medium uppercase text-ink-500">{view.storeName} · saída do motoboy</p>
        <h1 className="text-2xl font-semibold leading-tight">Oi, {view.courierName.split(" ")[0]}!</h1>
        <p className="text-sm text-ink-700">
          {pendingStops.length === 0
            ? "Tudo entregue."
            : `${pendingStops.length} ${pendingStops.length === 1 ? "entrega" : "entregas"} por fazer · ${RUN_STATUS_LABELS[view.status].toLowerCase()}`}
        </p>
      </header>

      {!running ? (
        <section className="flex flex-col gap-3 rounded-(--radius-soft) border border-gold-300 bg-ivory-50 p-4">
          <p className="text-sm text-ink-800">
            Ao sair da loja, toque abaixo. A página liga o GPS e compartilha sua posição com a {view.storeName} e com as clientes desta saída — só enquanto ela estiver aberta.
          </p>
          <button type="button" disabled={pending} onClick={() => run(() => startRunAction(token))} className={`${BIG_BUTTON} bg-ink-950 text-ivory-50 active:bg-ink-800`}>
            🛵 Comecei a rota
          </button>
        </section>
      ) : (
        <section className="flex flex-col gap-2 rounded-(--radius-soft) border border-ivory-300 bg-ivory-50 p-4 text-sm">
          <GpsStatus gps={gps} sentAgo={sentAgo} sendFailures={sendFailures} online={online} accuracyM={lastFix?.accuracyM ?? null} />
          {isIos ? <p className="text-xs text-ink-700">No iPhone, deixe esta página aberta na frente durante as entregas (num suporte de guidão, por exemplo) — em segundo plano o GPS para.</p> : null}
          {!isIos ? <p className="text-xs text-ink-700">Pode abrir o Waze por cima: no Android a posição continua sendo enviada. Só não feche esta aba.</p> : null}
        </section>
      )}

      {notice ? (
        <p role="status" className={`rounded-(--radius-soft) px-4 py-3 text-sm ${notice.tone === "ok" ? "bg-laurel-600/10 text-laurel-700" : "bg-claret-50 text-claret-700"}`}>
          {notice.text}
        </p>
      ) : null}

      <ol className="flex flex-col gap-4">
        {pendingStops.map((stop) => (
          <StopCard key={stop.id} stop={stop} token={token} running={running} pending={pending} position={position} onRun={run} />
        ))}
      </ol>

      {view.canFinish ? (
        <button type="button" disabled={pending} onClick={() => run(() => finishRunAction(token))} className={`${BIG_BUTTON} bg-laurel-700 text-ivory-50 active:bg-laurel-600`}>
          ✓ Encerrar saída
        </button>
      ) : null}

      {doneStops.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-store text-eyebrow font-medium uppercase text-ink-500">Fechadas · {doneStops.length}</h2>
          <ul className="flex flex-col divide-y divide-ivory-300 rounded-(--radius-soft) border border-ivory-300 bg-ivory-50">
            {doneStops.map((stop) => (
              <li key={stop.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 truncate">
                  {stop.sequence}. #{stop.orderNumber} · {stop.customerName}
                </span>
                <span className={`shrink-0 text-xs font-medium ${stop.status === "delivered" ? "text-laurel-700" : "text-claret-700"}`}>
                  {stop.status === "delivered" ? `Entregue${stop.receivedBy ? ` · ${stop.receivedBy}` : ""}` : stop.status === "failed" ? "Não entregue" : "Cancelada"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-4 text-center text-xs text-ink-500">
        Sua localização é compartilhada com a {view.storeName} e com as clientes desta saída só enquanto ela estiver aberta. Dúvida? Fale com a loja pelo WhatsApp.
      </footer>
    </main>
  );
}

function GpsStatus({ gps, sentAgo, sendFailures, online, accuracyM }: { gps: GpsDisplay; sentAgo: string | null; sendFailures: number; online: boolean; accuracyM: number | null }) {
  if (gps === "denied") {
    return (
      <p className="text-claret-700">
        <strong>O GPS está bloqueado para esta página.</strong> Toque no cadeado ao lado do endereço (ou em Ajustes → Safari → Localização) e permita a localização; depois recarregue.
      </p>
    );
  }
  if (gps === "unsupported") return <p className="text-claret-700">Este navegador não tem GPS disponível. Abra o link no Chrome ou no Safari.</p>;
  if (gps === "error") return <p className="text-claret-700">O GPS não respondeu. Confira se a localização do celular está ligada.</p>;
  if (gps === "starting") return <p className="text-ink-700">Ligando o GPS…</p>;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-ink-800">
      <span className="inline-flex items-center gap-1.5 font-medium text-laurel-700">
        <span className="h-2 w-2 animate-pulse rounded-full bg-laurel-600" /> GPS ativo
      </span>
      {sentAgo ? <span className="text-ink-500">· enviado {sentAgo}</span> : null}
      {accuracyM !== null && accuracyM > 100 ? <span className="text-ink-500">· sinal fraco (±{Math.round(accuracyM)} m)</span> : null}
      {!online ? <span className="text-claret-700">· sem internet — guardando para enviar depois</span> : sendFailures > 2 ? <span className="text-claret-700">· não consegui enviar; tentando de novo</span> : null}
    </p>
  );
}

type Stop = CourierRunProps["stops"][number];

function StopCard({
  stop,
  token,
  running,
  pending,
  position,
  onRun,
}: {
  stop: Stop;
  token: string;
  running: boolean;
  pending: boolean;
  position: { lat: number; lng: number; accuracyM: number | null } | null;
  onRun: (action: () => Promise<CourierActionResult>) => void;
}) {
  const [mode, setMode] = useState<"idle" | "deliver" | "fail">("idle");
  const [receivedBy, setReceivedBy] = useState("");
  const [reason, setReason] = useState<FailureReason>("ninguem_em_casa");
  const [note, setNote] = useState("");
  const wa = waMeUrl(stop.phoneE164);

  return (
    <li className="flex flex-col gap-3 rounded-(--radius-soft) border border-ivory-300 bg-ivory-50 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-store text-eyebrow font-medium uppercase text-ink-500">
            Parada {stop.sequence} · pedido #{stop.orderNumber}
          </p>
          <h2 className="text-lg font-semibold leading-tight">{stop.customerName}</h2>
          <p className="mt-1 text-base text-ink-900">{stop.addressLine ?? "Endereço não gravado — ligue para a cliente"}</p>
          {stop.windowLabel ? <p className="text-xs text-ink-500">{stop.windowLabel}</p> : null}
        </div>
      </div>

      {stop.collectCashCents !== null || stop.isGift ? (
        <div className="flex flex-wrap gap-2 text-sm font-medium">
          {stop.collectCashCents !== null ? <span className="rounded-(--radius-hair) bg-gold-200 px-2.5 py-1 text-gold-800">💵 Receber {formatCentsBRL(stop.collectCashCents)} em dinheiro</span> : null}
          {stop.isGift ? <span className="rounded-(--radius-hair) bg-rose-200 px-2.5 py-1 text-rose-700">🎁 É presente — sem falar de preço</span> : null}
        </div>
      ) : null}

      <ul className="text-sm text-ink-700">
        {stop.itemsSummary.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>

      <div className="flex gap-2">
        {stop.navigation ? (
          <>
            <a href={stop.navigation.waze} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
              Waze
            </a>
            <a href={stop.navigation.googleMaps} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
              Maps
            </a>
          </>
        ) : null}
        {stop.phoneE164 ? (
          <a href={`tel:${stop.phoneE164}`} className={LINK_BUTTON}>
            Ligar
          </a>
        ) : null}
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
            WhatsApp
          </a>
        ) : null}
      </div>

      {mode === "idle" ? (
        <div className="flex flex-col gap-2">
          <button type="button" disabled={!running || pending} onClick={() => setMode("deliver")} className={`${BIG_BUTTON} bg-ink-950 text-ivory-50 active:bg-ink-800`}>
            ✓ Entregue
          </button>
          <button type="button" disabled={!running || pending} onClick={() => setMode("fail")} className={`${BIG_BUTTON} border border-ink-900/30 bg-transparent text-ink-800 active:bg-ivory-200`}>
            Não consegui entregar
          </button>
          {!running ? <p className="text-center text-xs text-ink-500">Toque em “Comecei a rota” para liberar.</p> : null}
        </div>
      ) : null}

      {mode === "deliver" ? (
        <form
          className="flex flex-col gap-3 rounded-(--radius-soft) bg-ivory-200 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onRun(async () => {
              const result = await completeStopAction({ token, stopId: stop.id, receivedBy: receivedBy.trim() || null, position });
              if (result.ok) setMode("idle");
              return result;
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Quem recebeu?</span>
            <input
              value={receivedBy}
              onChange={(event) => setReceivedBy(event.target.value)}
              placeholder="Ex.: Maria, porteiro, a própria"
              autoComplete="off"
              enterKeyHint="done"
              className="min-h-12 rounded-(--radius-hair) border border-ivory-400 bg-ivory-50 px-3 text-base text-ink-900"
            />
          </label>
          <button type="submit" disabled={pending} className={`${BIG_BUTTON} bg-laurel-700 text-ivory-50 active:bg-laurel-600`}>
            {pending ? "Registrando…" : "Confirmar entrega"}
          </button>
          <button type="button" disabled={pending} onClick={() => setMode("idle")} className="min-h-11 text-sm text-ink-700 underline">
            Voltar
          </button>
        </form>
      ) : null}

      {mode === "fail" ? (
        <form
          className="flex flex-col gap-3 rounded-(--radius-soft) bg-ivory-200 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onRun(async () => {
              const result = await failStopAction({ token, stopId: stop.id, reason, note: note.trim() || null });
              if (result.ok) setMode("idle");
              return result;
            });
          }}
        >
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 font-medium">O que aconteceu?</legend>
            {FAILURE_REASONS.map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-3 rounded-(--radius-hair) bg-ivory-50 px-3">
                <input type="radio" name={`reason-${stop.id}`} value={value} checked={reason === value} onChange={() => setReason(value)} className="h-5 w-5" />
                {FAILURE_REASON_LABELS[value]}
              </label>
            ))}
          </fieldset>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Detalhe para a loja (opcional)"
            maxLength={200}
            className="min-h-12 rounded-(--radius-hair) border border-ivory-400 bg-ivory-50 px-3 text-base text-ink-900"
          />
          <button type="submit" disabled={pending} className={`${BIG_BUTTON} bg-claret-700 text-ivory-50 active:bg-claret-600`}>
            {pending ? "Avisando a loja…" : "Não consegui — avisar a loja"}
          </button>
          <button type="button" disabled={pending} onClick={() => setMode("idle")} className="min-h-11 text-sm text-ink-700 underline">
            Voltar
          </button>
        </form>
      ) : null}
    </li>
  );
}
