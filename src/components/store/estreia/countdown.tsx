"use client";
// Contagem regressiva da estreia: tica a cada segundo a partir do horário
// marcado; quando zera, recarrega a página (a cortina abre pelo relógio).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { countdownParts, type CountdownParts } from "@/core/drops";

/** Tentativas de recarregar depois da virada (ISR de 30 s + folga): ~2 min. */
const OPEN_RETRY_EVERY_MS = 6000;
const OPEN_RETRY_MAX = 20;

const UNITS: { key: keyof Omit<CountdownParts, "total">; singular: string; plural: string }[] = [
  { key: "days", singular: "dia", plural: "dias" },
  { key: "hours", singular: "hora", plural: "horas" },
  { key: "minutes", singular: "min", plural: "min" },
  { key: "seconds", singular: "seg", plural: "seg" },
];

export function Countdown({ publishAtIso, serverNowIso }: { publishAtIso: string; serverNowIso: string }) {
  const router = useRouter();
  // O primeiro desenho usa o relógio do servidor nos dois lados (sem
  // divergência na hidratação); o tique de 1 s assume em seguida.
  const [parts, setParts] = useState<CountdownParts>(() => countdownParts(new Date(publishAtIso), new Date(serverNowIso)));

  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const target = new Date(publishAtIso);
    let retries = 0;
    let retryTimer: number | undefined;
    // Na virada, a página pública é ISR: a primeira recarga pode pegar a cópia
    // velha. Insiste a cada poucos segundos (o servidor vira sozinho) até a
    // página trocar — quem espera não fica olhando 00:00:00.
    const retryRefresh = () => {
      retries += 1;
      router.refresh();
      if (retries < OPEN_RETRY_MAX) retryTimer = window.setTimeout(retryRefresh, OPEN_RETRY_EVERY_MS);
    };
    const tick = () => {
      const next = countdownParts(target, new Date());
      setParts(next);
      if (next.total === 0 && retries === 0) {
        setOpening(true);
        retryTimer = window.setTimeout(retryRefresh, 1500);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [publishAtIso, router]);

  if (opening) {
    return (
      <p className="font-display text-2xl italic text-ivory-100" role="status">
        A cortina está abrindo…
      </p>
    );
  }

  const visible = parts.days > 0 ? UNITS : UNITS.slice(1);
  return (
    <div className="flex items-end justify-center gap-4 sm:gap-6" role="timer" aria-live="off" aria-label="Tempo até a estreia">
      {visible.map((unit) => {
        const value = parts[unit.key];
        return (
          <div key={unit.key} className="flex min-w-14 flex-col items-center gap-1">
            <span className="font-display text-4xl leading-none text-ivory-50 tabular-nums sm:text-5xl">{String(value).padStart(2, "0")}</span>
            <span className="font-store text-eyebrow uppercase tracking-[0.18em] text-gold-400">{value === 1 ? unit.singular : unit.plural}</span>
          </div>
        );
      })}
    </div>
  );
}
