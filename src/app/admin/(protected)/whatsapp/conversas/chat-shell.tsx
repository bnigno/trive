"use client";

// Casca client do chat de atendimento. A seleção vive na URL (?c=<uuid>) e o
// useSearchParams é a fonte da verdade: a navegação usa History API nativa
// (replaceState no desktop, pushState no mobile), que o App Router sincroniza.
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "@/components/ui/cx";
import { useNotify } from "../../use-notify";
import { markConversationSeenAction, sendManualReplyAction } from "./actions";
import { ConversationList } from "./conversation-list";
import { maskPhone } from "./format";
import type { OptimisticDisplay } from "./message-list";
import { ThreadPanel } from "./thread-panel";
import {
  useChatPoll,
  type ChatConversation,
  type ChatMessage,
  type ChatPollResponse,
  type ChatThread,
} from "./use-chat-poll";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_TIMEOUT_MS = 30_000;
// Folga de relógio entre navegador e banco ao casar a bolha otimista com a
// mensagem real (created_at do servidor pode ficar "antes" do clique local).
const CLOCK_SKEW_MS = 30_000;

interface OptimisticMessage {
  tempId: string;
  conversationId: string;
  body: string;
  createdAt: string;
  status: "queued" | "failed";
  error: string | null;
}

export interface ChatShellProps {
  initialConversations: ChatConversation[];
  initialThread: ChatThread | null;
  initialThreadMeta: { phoneE164: string; customerName: string | null } | null;
  initialSelectedId: string | null;
}

export function ChatShell({
  initialConversations,
  initialThread,
  initialThreadMeta,
  initialSelectedId,
}: ChatShellProps) {
  const searchParams = useSearchParams();
  const rawSelected = searchParams.get("c");
  const selectedId =
    rawSelected && UUID_RE.test(rawSelected) ? rawSelected : null;

  const { notify } = useNotify();

  const [conversations, setConversations] = useState(initialConversations);
  const [threadConversation, setThreadConversation] = useState(
    initialThread?.conversation ?? null,
  );
  const [threadLoaded, setThreadLoaded] = useState(initialThread !== null);
  const [threadMissing, setThreadMissing] = useState(false);
  const [messagesMap, setMessagesMap] = useState<Map<string, ChatMessage>>(
    () => new Map((initialThread?.messages ?? []).map((m) => [m.id, m])),
  );
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);
  const [pollFailures, setPollFailures] = useState(0);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Espelhos para os callbacks assíncronos lerem o valor atual sem depender
  // do ciclo de render.
  const messagesMapRef = useRef(messagesMap);
  const optimisticRef = useRef(optimistic);
  useEffect(() => {
    optimisticRef.current = optimistic;
  }, [optimistic]);

  const prevListRef = useRef(
    new Map(
      initialConversations.map((c) => [
        c.id,
        {
          status: c.status,
          unreadCount: c.unreadCount,
          lastMessageAt: c.lastMessageAt,
        },
      ]),
    ),
  );
  const pendingSeenRef = useRef(false);
  const sendTimersRef = useRef(new Map<string, number>());
  const baseTitleRef = useRef<string | null>(null);
  const announceSeqRef = useRef(0);

  const announce = useCallback((text: string) => {
    // aria-live só re-anuncia quando o conteúdo muda: alterna um NBSP no fim
    // para o mesmo aviso repetido ser lido de novo.
    announceSeqRef.current += 1;
    setAnnouncement(announceSeqRef.current % 2 === 0 ? `${text}\u00A0` : text);
  }, []);

  const markSeen = useCallback((conversationId: string) => {
    void markConversationSeenAction(conversationId)
      .then((result) => {
        if (!result.ok) return;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId ? { ...c, unreadCount: 0 } : c,
          ),
        );
      })
      .catch(() => {
        // "Visto" é telemetria: falhar não pode atrapalhar o atendimento.
      });
  }, []);

  const handlePollResult = useCallback(
    (data: ChatPollResponse, requestedId: string | null) => {
      setPollFailures(0);

      const prevList = prevListRef.current;
      for (const conv of data.conversations) {
        const prev = prevList.get(conv.id) ?? null;
        const label = conv.customerName ?? maskPhone(conv.phoneE164);
        const becameHuman =
          conv.status === "human" && (prev === null || prev.status !== "human");
        if (becameHuman) {
          notify({
            kind: "handoff",
            title: "Robô transferiu uma conversa",
            body: label,
            conversationId: conv.id,
          });
          announce(`Conversa transferida para você: ${label}`);
        }
        const hasNewInbound =
          conv.lastMessageDirection === "inbound" &&
          conv.lastMessageAt !== null &&
          conv.unreadCount > (prev?.unreadCount ?? 0) &&
          conv.lastMessageAt !== (prev?.lastMessageAt ?? null);
        // A thread aberta cuida do próprio aviso mais abaixo (evita beep duplo).
        if (hasNewInbound && document.hidden && conv.id !== requestedId) {
          notify({
            kind: "inbound",
            title: `Nova mensagem de ${label}`,
            body: conv.lastMessagePreview ?? undefined,
            conversationId: conv.id,
          });
        }
      }
      prevListRef.current = new Map(
        data.conversations.map((c) => [
          c.id,
          {
            status: c.status,
            unreadCount: c.unreadCount,
            lastMessageAt: c.lastMessageAt,
          },
        ]),
      );
      setConversations(data.conversations);

      if (requestedId === null) return;

      const thread = data.thread;
      if (thread === null) {
        setThreadMissing(true);
        setThreadLoaded(true);
        setThreadConversation(null);
        return;
      }
      setThreadMissing(false);
      setThreadLoaded(true);
      setThreadConversation(thread.conversation);

      const prevMap = messagesMapRef.current;
      const newInbound = thread.messages.filter(
        (m) => m.direction === "inbound" && !prevMap.has(m.id),
      );
      const nextMap = new Map(prevMap);
      for (const m of thread.messages) nextMap.set(m.id, m);
      messagesMapRef.current = nextMap;
      setMessagesMap(nextMap);

      // Reconciliação do envio otimista: mensagem real outbound de origem
      // manual, mesmo texto, criada depois do clique (com folga de relógio).
      // Cada mensagem real consome no máximo uma bolha otimista.
      const manuals = thread.messages.filter(
        (m) => m.direction === "outbound" && m.origin === "manual",
      );
      if (manuals.length > 0 && optimisticRef.current.length > 0) {
        setOptimistic((prevOpt) => {
          const available = [...manuals];
          return prevOpt.filter((o) => {
            if (o.conversationId !== requestedId) return true;
            const index = available.findIndex(
              (m) =>
                m.body === o.body &&
                Date.parse(m.createdAt) >=
                  Date.parse(o.createdAt) - CLOCK_SKEW_MS,
            );
            if (index === -1) return true;
            available.splice(index, 1);
            const timer = sendTimersRef.current.get(o.tempId);
            if (timer !== undefined) {
              window.clearTimeout(timer);
              sendTimersRef.current.delete(o.tempId);
            }
            return false;
          });
        });
      }

      if (newInbound.length > 0) {
        const conv = data.conversations.find((c) => c.id === requestedId);
        const label = conv
          ? (conv.customerName ?? maskPhone(conv.phoneE164))
          : "cliente";
        announce(`Nova mensagem de ${label}`);
        if (document.hidden) {
          pendingSeenRef.current = true;
          notify({
            kind: "inbound",
            title: `Nova mensagem de ${label}`,
            body: newInbound[newInbound.length - 1]?.body,
            conversationId: requestedId,
          });
        } else {
          // Gatilho 2 do "visto": inbound nova com a thread aberta e visível.
          markSeen(requestedId);
        }
      }
    },
    [announce, markSeen, notify],
  );

  const handlePollFailure = useCallback(() => {
    setPollFailures((count) => count + 1);
  }, []);

  const { pollNow } = useChatPoll({
    selectedId,
    onResult: handlePollResult,
    onFailure: handlePollFailure,
  });

  // Troca de conversa: zera a thread anterior (o poll imediato do hook traz a
  // nova cauda). O estado semeado pelo SSR só vale para a seleção inicial.
  const prevSelectedRef = useRef(initialSelectedId);
  useEffect(() => {
    if (prevSelectedRef.current === selectedId) return;
    prevSelectedRef.current = selectedId;
    messagesMapRef.current = new Map();
    setMessagesMap(new Map());
    setThreadConversation(null);
    setThreadLoaded(false);
    setThreadMissing(false);
    pendingSeenRef.current = false;
  }, [selectedId]);

  // Gatilho 1 do "visto": thread montada/aberta com a aba visível.
  useEffect(() => {
    if (!selectedId) return;
    if (document.hidden) {
      pendingSeenRef.current = true;
      return;
    }
    markSeen(selectedId);
  }, [selectedId, markSeen]);

  // Gatilho 3 do "visto": aba voltou a ficar visível com pendência.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden || !pendingSeenRef.current) return;
      pendingSeenRef.current = false;
      const id = selectedIdRef.current;
      if (id) markSeen(id);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [markSeen]);

  // Título da aba: "(N) Conversas" com a soma de não-lidas; restaura ao sair.
  const unreadTotal = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    [conversations],
  );
  useEffect(() => {
    baseTitleRef.current ??= document.title;
    const base = baseTitleRef.current;
    document.title = unreadTotal > 0 ? `(${unreadTotal}) Conversas` : base;
    return () => {
      document.title = base;
    };
  }, [unreadTotal]);

  // Limpeza dos timeouts de envio pendentes ao desmontar.
  useEffect(() => {
    const timers = sendTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  const failOptimistic = useCallback((tempId: string, error: string) => {
    const timer = sendTimersRef.current.get(tempId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      sendTimersRef.current.delete(tempId);
    }
    setOptimistic((prev) =>
      prev.map((o) =>
        o.tempId === tempId && o.status === "queued"
          ? { ...o, status: "failed" as const, error }
          : o,
      ),
    );
  }, []);

  const scheduleSendTimeout = useCallback(
    (tempId: string) => {
      const timer = window.setTimeout(() => {
        failOptimistic(
          tempId,
          "Não foi possível confirmar o envio. Verifique a conexão.",
        );
      }, SEND_TIMEOUT_MS);
      sendTimersRef.current.set(tempId, timer);
    },
    [failOptimistic],
  );

  const submitSend = useCallback(
    (tempId: string, conversationId: string, body: string) => {
      void sendManualReplyAction(conversationId, body)
        .then((result) => {
          if ("error" in result) {
            failOptimistic(tempId, result.error);
            return;
          }
          // A confirmação visual vem do poll (a bolha real substitui a
          // otimista); poll imediato para não esperar os 3s.
          pollNow();
        })
        .catch(() => failOptimistic(tempId, "Falha ao enviar. Tente de novo."));
    },
    [failOptimistic, pollNow],
  );

  const handleSend = useCallback(
    (body: string) => {
      const conversationId = selectedIdRef.current;
      if (!conversationId) return;
      const tempId =
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setOptimistic((prev) => [
        ...prev,
        {
          tempId,
          conversationId,
          body,
          createdAt: new Date().toISOString(),
          status: "queued" as const,
          error: null,
        },
      ]);
      setScrollSignal((n) => n + 1);
      scheduleSendTimeout(tempId);
      submitSend(tempId, conversationId, body);
    },
    [scheduleSendTimeout, submitSend],
  );

  const handleRetry = useCallback(
    (tempId: string) => {
      const target = optimisticRef.current.find((o) => o.tempId === tempId);
      if (!target || target.status !== "failed") return;
      const createdAt = new Date().toISOString();
      setOptimistic((prev) =>
        prev.map((o) =>
          o.tempId === tempId
            ? { ...o, status: "queued" as const, error: null, createdAt }
            : o,
        ),
      );
      setScrollSignal((n) => n + 1);
      scheduleSendTimeout(tempId);
      submitSend(tempId, target.conversationId, target.body);
    },
    [scheduleSendTimeout, submitSend],
  );

  const handleSelect = useCallback((id: string) => {
    if (id === selectedIdRef.current) return;
    const url = `/admin/whatsapp/conversas?c=${id}`;
    // replaceState no desktop (a lista segue visível, não polui o histórico);
    // pushState no mobile para o botão de voltar fechar a thread.
    if (window.matchMedia("(min-width: 768px)").matches) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
  }, []);

  const handleBack = useCallback(() => {
    const before = window.location.search;
    window.history.back();
    // Deep link (notificação/atalho): sem entrada anterior o back não muda a
    // URL — cai no fallback e limpa o ?c= trocando o estado atual.
    window.setTimeout(() => {
      if (window.location.search === before) {
        window.history.replaceState(null, "", "/admin/whatsapp/conversas");
      }
    }, 250);
  }, []);

  const sortedMessages = useMemo(() => {
    const arr = Array.from(messagesMap.values());
    // Mesma ordem do servidor: (created_at, id) — ISO 8601 compara certo
    // como string e o id desempata mensagens nascidas na mesma transação.
    arr.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return arr;
  }, [messagesMap]);

  const listItem = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  const fromInitial = selectedId !== null && selectedId === initialSelectedId;
  const customerName =
    listItem?.customerName ??
    (fromInitial ? (initialThreadMeta?.customerName ?? null) : null);
  const phoneE164 =
    listItem?.phoneE164 ?? (fromInitial ? (initialThreadMeta?.phoneE164 ?? "") : "");
  const status = threadConversation?.status ?? listItem?.status ?? "open";
  const botDisabledUntil =
    threadConversation?.botDisabledUntil ?? listItem?.botDisabledUntil ?? null;

  const optimisticForSelected = useMemo<OptimisticDisplay[]>(
    () =>
      optimistic
        .filter((o) => o.conversationId === selectedId)
        .map(({ tempId, body, createdAt, status: optStatus, error }) => ({
          tempId,
          body,
          createdAt,
          status: optStatus,
          error,
        })),
    [optimistic, selectedId],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {pollFailures >= 2 ? (
        <div
          role="status"
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
        >
          Reconectando…
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 md:grid-cols-[360px_1fr]">
        <section
          aria-label="Lista de conversas"
          className={cx(
            "min-h-0 min-w-0 flex-col border-zinc-200 md:border-r dark:border-zinc-800",
            selectedId ? "hidden md:flex" : "flex",
          )}
        >
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
        </section>
        <section
          aria-label="Conversa aberta"
          className={cx(
            "min-h-0 min-w-0 flex-col",
            selectedId ? "flex" : "hidden md:flex",
          )}
        >
          <ThreadPanel
            selectedId={selectedId}
            customerName={customerName}
            phoneE164={phoneE164}
            status={status}
            botDisabledUntil={botDisabledUntil}
            loaded={threadLoaded}
            missing={threadMissing}
            messages={sortedMessages}
            optimistic={optimisticForSelected}
            scrollSignal={scrollSignal}
            onSend={handleSend}
            onRetry={handleRetry}
            onBack={handleBack}
            pollNow={pollNow}
          />
        </section>
      </div>
    </div>
  );
}
