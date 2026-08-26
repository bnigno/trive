"use client";

// Conversa de e-mail: cartões empilhados em ordem cronológica, separador de
// dia e rolagem educada (só desce sozinho quando o dono já está no fim).
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { dayKeySP, daySeparatorLabel } from "./email-format";
import { MessageCard } from "./message-card";
import type { InboxMessage } from "./use-inbox-poll";

const BOTTOM_THRESHOLD_PX = 48;

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
  senderName,
  participantEmail,
  threadSubject,
  scrollSignal,
  onRetry,
}: {
  messages: InboxMessage[];
  optimistic: OptimisticDisplay[];
  senderName: string;
  participantEmail: string;
  threadSubject: string;
  /** Incrementado a cada envio do dono: força a rolagem até o fim. */
  scrollSignal: number;
  onRetry: (tempId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const atBottomRef = useRef(true);
  const firstRunRef = useRef(true);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const lastScrollSignalRef = useRef(scrollSignal);

  // A resposta ainda não confirmada vira um cartão igual aos outros no fim da
  // lista — o poll depois troca este pelo real, sem a tela piscar.
  const optimisticIds = useMemo(
    () => new Set(optimistic.map((o) => o.tempId)),
    [optimistic],
  );
  const all = useMemo<InboxMessage[]>(
    () => [
      ...messages,
      ...optimistic.map((o) => ({
        id: o.tempId,
        direction: "outbound" as const,
        fromAddress: "",
        fromName: null,
        toAddresses: participantEmail ? [participantEmail] : [],
        subject: "",
        textBody: o.body,
        htmlBody: null,
        attachments: [],
        status: o.status,
        errorDetail: o.error,
        createdAt: o.createdAt,
      })),
    ],
    [messages, optimistic, participantEmail],
  );

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

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

  const rows = useMemo(() => {
    const built: ReactNode[] = [];
    let prevDayKey = "";
    for (const message of all) {
      const dayKey = dayKeySP(message.createdAt);
      if (dayKey !== prevDayKey) {
        built.push(
          <div key={`day-${dayKey}`} className="my-1 flex justify-center">
            <span className="rounded-md bg-zinc-200/70 px-2.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {daySeparatorLabel(message.createdAt)}
            </span>
          </div>,
        );
        prevDayKey = dayKey;
      }
      built.push(
        <MessageCard
          key={message.id}
          message={message}
          senderName={senderName}
          threadSubject={threadSubject}
          onRetry={
            optimisticIds.has(message.id) && message.status === "failed"
              ? () => onRetry(message.id)
              : undefined
          }
        />,
      );
    }
    return built;
  }, [all, optimisticIds, onRetry, senderName, threadSubject]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto bg-zinc-100 px-3 py-3 md:px-6 dark:bg-zinc-950"
      >
        {all.length === 0 ? (
          <p className="mt-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Nenhuma mensagem nesta conversa ainda.
          </p>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2.5">{rows}</div>
        )}
      </div>
      {pendingCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            setPendingCount(0);
            scrollToBottom(true);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-md transition-colors hover:bg-indigo-700 motion-reduce:transition-none"
        >
          {pendingCount === 1
            ? "1 mensagem nova ↓"
            : `${pendingCount} mensagens novas ↓`}
        </button>
      ) : null}
    </div>
  );
}
