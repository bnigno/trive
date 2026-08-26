"use client";

// Crachá de "e-mails aguardando" no menu lateral, visível em qualquer página
// do painel. Usa o modo leve do poll (`?light=1`), que só conta — sem lista e
// sem conversa. 60 segundos de base: é um número no canto da tela, não uma
// tela de atendimento, e a caixa só recebe novidade quando o cron lê o IMAP.
import { useEffect, useState } from "react";
import { z } from "zod";

const POLL_URL = "/admin/emails/poll?light=1";
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 240_000;

// Fronteira de rede: parse, não cast.
const lightResponseSchema = z.object({
  serverTime: z.string(),
  awaitingCount: z.number(),
});

export function EmailNavBadge() {
  const [awaitingCount, setAwaitingCount] = useState(0);

  useEffect(() => {
    let delay = BASE_DELAY_MS;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let disposed = false;

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void poll();
      }, ms);
    };

    const poll = async () => {
      if (disposed || document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(POLL_URL, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const parsed = lightResponseSchema.safeParse(
          (await res.json()) as unknown,
        );
        if (!parsed.success) throw new Error("poll shape");
        if (disposed) return;
        delay = BASE_DELAY_MS;
        setAwaitingCount(parsed.data.awaitingCount);
      } catch (error) {
        if (disposed) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        // Falha silenciosa (endpoint fora do ar, 401, formato inesperado):
        // mantém o último número na tela e só recua o ritmo.
        delay = Math.min(delay * 2, MAX_DELAY_MS);
      }
      if (!disposed && !document.hidden) schedule(delay);
    };

    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (document.hidden) {
        controller?.abort();
      } else {
        void poll();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  if (awaitingCount === 0) return null;

  return (
    <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-semibold text-white">
      {awaitingCount}
      <span className="sr-only"> e-mails aguardando resposta</span>
    </span>
  );
}
