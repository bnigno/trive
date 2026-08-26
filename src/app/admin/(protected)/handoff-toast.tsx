"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui/cx";

/**
 * Toasts de transferência ("Robô transferiu uma conversa").
 *
 * Uso (wa-nav-badge hoje; a página de conversas pode reutilizar):
 *
 *   const { toasts, pushToast, dismissToast } = useHandoffToasts();
 *   pushToast({ conversationId, label });
 *   return (
 *     <>
 *       ...
 *       <HandoffToastViewport toasts={toasts} onDismiss={dismissToast} />
 *     </>
 *   );
 */

export type HandoffToastItem = {
  id: string;
  conversationId: string;
  label: string;
};

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 10_000;

export function useHandoffToasts(): {
  toasts: HandoffToastItem[];
  pushToast(input: { conversationId: string; label: string }): void;
  dismissToast(id: string): void;
} {
  const [toasts, setToasts] = useState<HandoffToastItem[]>([]);
  const nextIdRef = useRef(0);

  const pushToast = useCallback(
    (input: { conversationId: string; label: string }) => {
      nextIdRef.current += 1;
      const id = `handoff-${nextIdRef.current}`;
      setToasts((prev) => [...prev, { id, ...input }].slice(-MAX_TOASTS));
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, pushToast, dismissToast };
}

// Store vazio para detectar "estamos no cliente?" sem setState em efeito:
// no servidor o snapshot é false e o portal não renderiza.
const emptySubscribe = () => () => {};

export function HandoffToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: HandoffToastItem[];
  onDismiss(id: string): void;
}) {
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  if (!mounted || toasts.length === 0) return null;

  return createPortal(
    // stopPropagation: o portal propaga eventos pela árvore REACT (não pelo
    // DOM) — este viewport é montado dentro do <Link> da sidebar, e sem isso
    // um clique no toast navegaria para /admin/whatsapp.
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col gap-3"
      onClick={(event) => event.stopPropagation()}
    >
      {toasts.map((toast) => (
        <HandoffToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

function HandoffToastCard({
  toast,
  onDismiss,
}: {
  toast: HandoffToastItem;
  onDismiss(id: string): void;
}) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // rAF garante um paint no estado inicial antes da transição de entrada.
    const raf = requestAnimationFrame(() => setEntered(true));
    const timer = window.setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [toast.id, onDismiss]);

  return (
    <div
      role="status"
      className={cx(
        "w-80 rounded-xl border border-zinc-200 bg-white p-4 shadow-lg",
        "transition duration-300 motion-reduce:transition-none",
        "dark:border-zinc-700 dark:bg-zinc-900",
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#25d366]/15 text-[#128c5e] dark:text-[#25d366]">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.4-4.1-1L3 20l1-5.4A8.5 8.5 0 1 1 21 11.5Z" />
            <path d="M9 11h.01M12 11h.01M15 11h.01" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Robô transferiu uma conversa
          </p>
          <p className="truncate text-sm text-zinc-600 dark:text-zinc-400">
            {toast.label}
          </p>
          <Link
            href={`/admin/whatsapp/conversas?c=${toast.conversationId}`}
            onClick={() => onDismiss(toast.id)}
            className="mt-1 inline-block text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Abrir conversa
          </Link>
        </div>
        <button
          type="button"
          aria-label="Fechar aviso"
          onClick={() => onDismiss(toast.id)}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
