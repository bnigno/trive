"use client";

// O avisador do painel: UMA instância no layout, dona do poll leve, dos
// toasts, do bipe/aviso de sistema e do "(N)" no título da aba. Os crachás
// do menu só leem o store. Na página de conversas ele descansa: o chat tem
// poll próprio (3 s), avisa do seu jeito e alimenta o mesmo store — sem isso
// haveria bipe e toast duplos.
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import {
  CHAT_PATH,
  freshUnseen,
  IDLE_AFTER_MS,
  notificationFor,
  pollDelayMs,
  rememberUnseen,
  toastTitleFor,
  withUnreadPrefix,
} from "./admin-notifier-logic";
import { HandoffToastViewport, useHandoffToasts } from "./handoff-toast";
import { useNotify } from "./use-notify";
import { publishWaUnseen, useWaUnseen } from "./wa-unseen-store";
import { lightPollResponseSchema, type LightPollResponse } from "./whatsapp/conversas/poll/light-schema";

const POLL_URL = "/admin/whatsapp/conversas/poll?light=1";
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export function AdminNotifier() {
  const pathname = usePathname();
  const onChatPage = pathname.startsWith(CHAT_PATH);
  const { toasts, pushToast, dismissToast } = useHandoffToasts();
  const { notify } = useNotify();
  const { withNewMessages } = useWaUnseen();

  useEffect(() => {
    if (onChatPage) return;

    let known = rememberUnseen([]);
    const knownSuggestionIds = new Set<string>();
    // O primeiro poll só semeia o que já existe: nada de avisar de novo o
    // que estava lá antes de abrir a página.
    let firstPollDone = false;
    let failures = 0;
    let lastActiveAt = Date.now();
    let idle = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let disposed = false;

    const handleResult = (result: LightPollResponse) => {
      publishWaUnseen({
        awaitingOwner: result.awaitingOwner,
        withNewMessages: result.withNewMessages,
        suggestionCount: result.suggestionCount,
      });
      const fresh = freshUnseen(known, result.unseen);
      known = rememberUnseen(result.unseen);
      const freshSuggestions = result.suggestions.filter((item) => !knownSuggestionIds.has(item.id));
      knownSuggestionIds.clear();
      for (const item of result.suggestions) knownSuggestionIds.add(item.id);

      if (firstPollDone) {
        for (const item of fresh) {
          pushToast({ conversationId: item.id, label: item.preview ?? "Mensagem nova", title: toastTitleFor(item) });
        }
        for (const item of freshSuggestions) {
          pushToast({ conversationId: item.id, label: item.label, title: "A vendedora sugeriu uma resposta" });
        }
        // Um bipe (e um aviso de sistema) por lote, não por mensagem.
        const alert = notificationFor(fresh, freshSuggestions);
        if (alert) {
          notify({
            kind: fresh.some((item) => item.status === "human") ? "handoff" : "inbound",
            title: alert.title,
            body: alert.body,
            conversationId: alert.conversationId,
          });
        }
      }
      firstPollDone = true;
    };

    const schedule = () => {
      window.clearTimeout(timer);
      const idleForMs = Date.now() - lastActiveAt;
      idle = !document.hidden && idleForMs >= IDLE_AFTER_MS;
      timer = window.setTimeout(() => {
        void poll();
      }, pollDelayMs({ hidden: document.hidden, idleForMs, failures }));
    };

    const poll = async () => {
      if (disposed) return;
      window.clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(POLL_URL, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const parsed = lightPollResponseSchema.safeParse((await res.json()) as unknown);
        if (!parsed.success) throw new Error("poll shape");
        if (disposed) return;
        failures = 0;
        handleResult(parsed.data);
      } catch (error) {
        if (disposed) return;
        // Abortado por um poll mais novo (voltou para a aba, mexeu depois de
        // parado): quem abortou é quem agenda o próximo.
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Falha silenciosa (endpoint fora do ar, 401, formato inesperado):
        // mantém o último número na tela e só recua o ritmo.
        failures += 1;
      }
      if (!disposed) schedule();
    };

    const onActivity = () => {
      lastActiveAt = Date.now();
      if (idle) {
        idle = false;
        void poll();
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        schedule();
      } else {
        lastActiveAt = Date.now();
        void poll();
      }
    };

    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onChatPage, notify, pushToast]);

  // "(N) Pedidos | TRIVÉ" em qualquer página. O Next reescreve o <title> a
  // cada navegação: o observer reaplica o prefixo sem brigar (só escreve
  // quando o texto está diferente, então não realimenta a si mesmo). Na
  // página de conversas o chat cuida do próprio "(N) Conversas".
  useEffect(() => {
    if (onChatPage) return;
    const apply = () => {
      const next = withUnreadPrefix(document.title, withNewMessages);
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      const bare = withUnreadPrefix(document.title, 0);
      if (document.title !== bare) document.title = bare;
    };
  }, [onChatPage, withNewMessages]);

  return <HandoffToastViewport toasts={toasts} onDismiss={dismissToast} />;
}
