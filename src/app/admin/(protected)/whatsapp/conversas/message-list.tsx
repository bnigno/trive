"use client";

// Lista de mensagens da thread: papel marfim com grão sutil, separadores de
// dia, agrupamento de bolhas, linhas do que a vendedora fez em cada turno,
// auto-scroll educado (só quando o dono já está no fim) e janela das
// últimas 100 mensagens com preservação de scroll.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { dayKeySP, daySeparatorLabel } from "./chat-format";
import { TypingDots } from "./conversation-item";
import { describeTools } from "./format";
import { MessageBubble } from "./message-bubble";
import type { ChatActivity, ChatMessage } from "./use-chat-poll";

const WINDOW_STEP = 100;
const BOTTOM_THRESHOLD_PX = 48;
const GROUP_GAP_MS = 5 * 60_000;

export interface OptimisticDisplay {
  tempId: string;
  body: string;
  createdAt: string;
  status: "queued" | "failed";
  error: string | null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MessageList({
  messages,
  optimistic,
  activity,
  sellerName,
  sellerTyping,
  scrollSignal,
  onRetry,
}: {
  messages: ChatMessage[];
  optimistic: OptimisticDisplay[];
  /** Ferramentas que a vendedora usou por mensagem recebida (trilha do turno). */
  activity: ChatActivity[];
  sellerName: string;
  sellerTyping: boolean;
  /** Incrementado a cada envio do dono: força scroll ao fim mesmo longe dele. */
  scrollSignal: number;
  onRetry: (tempId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  const [pendingCount, setPendingCount] = useState(0);
  const atBottomRef = useRef(true);
  const firstRunRef = useRef(true);
  const preserveRef = useRef<{ prevHeight: number; prevTop: number } | null>(
    null,
  );
  const prevIdsRef = useRef<Set<string>>(new Set());
  const lastScrollSignalRef = useRef(scrollSignal);

  const hiddenCount = Math.max(0, messages.length - windowSize);
  const visible = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  // Bolhas otimistas viram pseudo-mensagens no fim da lista, participando do
  // agrupamento e dos ticks como qualquer outra.
  const optimisticIds = useMemo(
    () => new Set(optimistic.map((o) => o.tempId)),
    [optimistic],
  );
  const all = useMemo<ChatMessage[]>(
    () => [
      ...visible,
      ...optimistic.map((o) => ({
        id: o.tempId,
        direction: "outbound" as const,
        origin: "manual" as const,
        kind: "text",
        body: o.body,
        mediaUrl: null,
        status: o.status,
        errorDetail: o.error,
        createdAt: o.createdAt,
      })),
    ],
    [visible, optimistic],
  );

  const activityByInbound = useMemo(
    () => new Map(activity.map((turn) => [turn.inboundId, turn])),
    [activity],
  );

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  }, []);

  // Reação a mudanças na lista: preservar posição na expansão da janela,
  // abrir já no fim, auto-scroll se estava no fim, senão contar no pill.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (preserveRef.current) {
      const { prevHeight, prevTop } = preserveRef.current;
      preserveRef.current = null;
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      prevIdsRef.current = new Set(all.map((m) => m.id));
      return;
    }

    const prevIds = prevIdsRef.current;
    const appended = all.reduce(
      (sum, m) => (prevIds.has(m.id) ? sum : sum + 1),
      0,
    );
    prevIdsRef.current = new Set(all.map((m) => m.id));

    if (firstRunRef.current) {
      firstRunRef.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }

    const forcedBySend = scrollSignal !== lastScrollSignalRef.current;
    lastScrollSignalRef.current = scrollSignal;
    if (forcedBySend) {
      setPendingCount(0);
      scrollToBottom(true);
      return;
    }

    if (appended === 0) return;
    if (atBottomRef.current) {
      scrollToBottom(true);
    } else {
      setPendingCount((count) => count + appended);
    }
  }, [all, scrollSignal, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setPendingCount((count) => (count === 0 ? count : 0));
  }, []);

  const handleShowMore = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      preserveRef.current = {
        prevHeight: el.scrollHeight,
        prevTop: el.scrollTop,
      };
    }
    setWindowSize((size) => size + WINDOW_STEP);
  }, []);

  // Imagem que terminou de carregar muda a altura: re-encosta no fim se o
  // dono já estava lá.
  const handleImageLoad = useCallback(() => {
    if (atBottomRef.current) scrollToBottom(false);
  }, [scrollToBottom]);

  const rows = useMemo(() => {
    const built: ReactNode[] = [];
    let prev: ChatMessage | null = null;
    let prevDayKey = "";
    for (const message of all) {
      const dayKey = dayKeySP(message.createdAt);
      if (dayKey !== prevDayKey) {
        built.push(
          <div key={`day-${dayKey}`} className="my-3 flex justify-center">
            <span className="rounded-full border border-ivory-300 bg-ivory-50/90 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-ink-500 dark:border-ink-700 dark:bg-ink-900/90 dark:text-ink-300">
              {daySeparatorLabel(message.createdAt)}
            </span>
          </div>,
        );
      }
      const grouped =
        prev !== null &&
        dayKey === prevDayKey &&
        prev.direction === message.direction &&
        prev.origin === message.origin &&
        Date.parse(message.createdAt) - Date.parse(prev.createdAt) <
          GROUP_GAP_MS;
      const isOptimistic = optimisticIds.has(message.id);
      built.push(
        <MessageBubble
          key={message.id}
          message={message}
          firstOfGroup={!grouped}
          sellerName={sellerName}
          onRetry={
            isOptimistic && message.status === "failed"
              ? () => onRetry(message.id)
              : undefined
          }
          onImageLoad={handleImageLoad}
        />,
      );
      // Linha do que a vendedora fez ao responder esta mensagem da cliente.
      const turn =
        message.direction === "inbound"
          ? activityByInbound.get(message.id)
          : undefined;
      const described = turn ? describeTools(turn.tools) : null;
      if (turn && (described || turn.handedOff)) {
        built.push(
          <p
            key={`turn-${message.id}`}
            className="mt-1.5 flex justify-center px-6 text-center text-[11px] italic text-ink-400 dark:text-ink-400"
          >
            <span>
              <span className="font-medium not-italic text-gold-700 dark:text-gold-400">
                {sellerName}
              </span>{" "}
              {described ?? "passou para você"}
            </span>
          </p>,
        );
      }
      prev = message;
      prevDayKey = dayKey;
    }
    return built;
  }, [all, optimisticIds, onRetry, handleImageLoad, activityByInbound, sellerName]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="wa-paper h-full overflow-y-auto px-4 py-3 md:px-6"
      >
        {hiddenCount > 0 ? (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={handleShowMore}
              className="rounded-full border border-ivory-300 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 shadow-sm transition-colors hover:bg-ivory-100 motion-reduce:transition-none dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300 dark:hover:bg-ink-800"
            >
              Mostrar mensagens anteriores ({hiddenCount})
            </button>
          </div>
        ) : null}
        {all.length === 0 ? (
          <p className="mt-8 text-center text-sm text-ink-500 dark:text-ink-300">
            Nenhuma mensagem nesta conversa ainda.
          </p>
        ) : (
          <div className="flex flex-col pb-1">
            {rows}
            {sellerTyping ? (
              <div className="mt-2.5 flex justify-end">
                <div className="wa-tail-out relative rounded-xl rounded-tr-none bg-ink-900 px-3 py-2 text-ivory-300 shadow-sm dark:bg-ivory-100 dark:text-ink-500">
                  <span className="flex items-center gap-2 text-[11px] italic">
                    <TypingDots />
                    {sellerName} está respondendo…
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {pendingCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            setPendingCount(0);
            scrollToBottom(true);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-ink-900 px-3 py-1.5 text-xs font-medium text-ivory-50 shadow-md transition-colors hover:bg-ink-800 motion-reduce:transition-none dark:bg-ivory-100 dark:text-ink-900 dark:hover:bg-ivory-200"
        >
          {pendingCount === 1
            ? "1 nova mensagem ↓"
            : `${pendingCount} novas mensagens ↓`}
        </button>
      ) : null}
    </div>
  );
}
