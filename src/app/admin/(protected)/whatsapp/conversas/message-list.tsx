"use client";

// Lista de mensagens da thread: wallpaper pontilhado, separadores de dia,
// agrupamento de bolhas, auto-scroll educado (só quando o dono já está no
// fim) e janela das últimas 100 mensagens com preservação de scroll.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { dayKeySP, daySeparatorLabel } from "./chat-format";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "./use-chat-poll";

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
  scrollSignal,
  onRetry,
}: {
  messages: ChatMessage[];
  optimistic: OptimisticDisplay[];
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
            <span className="rounded-md bg-white/90 px-3 py-1 text-xs text-[#54656f] shadow-sm dark:bg-[#182229] dark:text-[#8696a0]">
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
          onRetry={
            isOptimistic && message.status === "failed"
              ? () => onRetry(message.id)
              : undefined
          }
          onImageLoad={handleImageLoad}
        />,
      );
      prev = message;
      prevDayKey = dayKey;
    }
    return built;
  }, [all, optimisticIds, onRetry, handleImageLoad]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto bg-[#efeae2] px-4 py-3 [background-image:radial-gradient(circle_at_center,rgba(0,0,0,0.04)_1px,transparent_1.5px)] [background-size:22px_22px] md:px-6 dark:bg-[#0b141a] dark:[background-image:radial-gradient(circle_at_center,rgba(255,255,255,0.035)_1px,transparent_1.5px)]"
      >
        {hiddenCount > 0 ? (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={handleShowMore}
              className="rounded-full bg-white/90 px-3 py-1.5 text-xs font-medium text-[#008069] shadow-sm transition-colors hover:bg-white motion-reduce:transition-none dark:bg-[#182229] dark:text-[#06cf9c] dark:hover:bg-[#202c33]"
            >
              Mostrar mensagens anteriores ({hiddenCount})
            </button>
          </div>
        ) : null}
        {all.length === 0 ? (
          <p className="mt-8 text-center text-sm text-[#54656f] dark:text-[#8696a0]">
            Nenhuma mensagem nesta conversa ainda.
          </p>
        ) : (
          <div className="flex flex-col pb-1">{rows}</div>
        )}
      </div>
      {pendingCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            setPendingCount(0);
            scrollToBottom(true);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-[#008069] shadow-md transition-colors hover:bg-zinc-50 motion-reduce:transition-none dark:bg-[#202c33] dark:text-[#06cf9c] dark:hover:bg-[#233138]"
        >
          {pendingCount === 1
            ? "1 nova mensagem ↓"
            : `${pendingCount} novas mensagens ↓`}
        </button>
      ) : null}
    </div>
  );
}
