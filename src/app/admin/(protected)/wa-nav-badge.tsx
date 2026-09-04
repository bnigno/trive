"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { HandoffToastViewport, useHandoffToasts } from "./handoff-toast";
import { useNotify } from "./use-notify";

const POLL_URL = "/admin/whatsapp/conversas/poll?light=1";
const BASE_DELAY_MS = 25_000;
const MAX_DELAY_MS = 100_000;

type LightPollResponse = {
  serverTime: string;
  humanCount: number;
  awaiting: Array<{ id: string; label: string }>;
};

function parseLightResponse(data: unknown): LightPollResponse | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.humanCount !== "number") return null;
  if (!Array.isArray(record.awaiting)) return null;
  const awaiting: LightPollResponse["awaiting"] = [];
  for (const item of record.awaiting) {
    if (typeof item !== "object" || item === null) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.label !== "string") {
      return null;
    }
    awaiting.push({ id: entry.id, label: entry.label });
  }
  return {
    serverTime: typeof record.serverTime === "string" ? record.serverTime : "",
    humanCount: record.humanCount,
    awaiting,
  };
}

export function WaNavBadge() {
  const pathname = usePathname();
  const [humanCount, setHumanCount] = useState(0);
  const { toasts, pushToast, dismissToast } = useHandoffToasts();
  const { notify } = useNotify();

  // Refs para o loop de poll ler os valores atuais sem reiniciar o efeito
  // (reiniciar zeraria o Set de awaiting e re-dispararia toasts ao navegar).
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const knownAwaitingIds = new Set<string>();
    let firstPollDone = false;
    let delay = BASE_DELAY_MS;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let disposed = false;

    const handleResult = (result: LightPollResponse) => {
      setHumanCount(result.humanCount);
      const fresh = result.awaiting.filter(
        (item) => !knownAwaitingIds.has(item.id),
      );
      // O Set espelha o awaiting atual: quem sai e volta a aguardar
      // (nova transferência da mesma conversa) conta como novo de novo.
      knownAwaitingIds.clear();
      for (const item of result.awaiting) knownAwaitingIds.add(item.id);

      if (firstPollDone && fresh.length > 0) {
        // Na página de conversas o shell do chat cuida do aviso (toast e
        // som próprios); duplicar aqui geraria beep/toast duplo.
        const onChatPage = pathnameRef.current.startsWith(
          "/admin/whatsapp/conversas",
        );
        if (!onChatPage) {
          for (const item of fresh) {
            pushToast({ conversationId: item.id, label: item.label });
            notify({
              kind: "handoff",
              title: "Robô transferiu uma conversa",
              body: item.label,
              conversationId: item.id,
            });
          }
        }
      }
      firstPollDone = true;
    };

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void poll();
      }, ms);
    };

    const poll = async () => {
      if (disposed || document.hidden) return;
      controller = new AbortController();
      try {
        const res = await fetch(POLL_URL, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const parsed = parseLightResponse((await res.json()) as unknown);
        if (!parsed) throw new Error("poll shape");
        if (disposed) return;
        delay = BASE_DELAY_MS;
        handleResult(parsed);
      } catch (error) {
        if (disposed) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        // Falha silenciosa (endpoint fora do ar, 401, shape inválido):
        // mantém o último valor exibido e só recua o ritmo.
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
  }, [notify, pushToast]);

  return (
    <>
      {humanCount > 0 ? (
        <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-gold-600 px-1.5 text-[11px] font-semibold text-white">
          {humanCount}
        </span>
      ) : null}
      <HandoffToastViewport toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
