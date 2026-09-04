"use client";

import { useEffect, useRef, useState } from "react";

import { cx } from "@/components/ui/cx";

// ~6 linhas de texto (20px de linha + padding) antes de rolar internamente.
const MAX_HEIGHT_PX = 136;

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path
        d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Composer({
  attendant,
  sellerName,
  quickReplies,
  onSend,
}: {
  /** Quem responde a próxima mensagem — muda o aviso acima da caixa. */
  attendant: "seller" | "you" | "nobody";
  sellerName: string;
  quickReplies: string[];
  onSend: (body: string) => void;
}) {
  const [value, setValue] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Foco automático só em md+: no celular abriria o teclado por cima da thread.
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      textareaRef.current?.focus();
    }
  }, []);

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  };

  const submit = () => {
    const body = value.trim();
    if (!body) return;
    onSend(body);
    setValue("");
    setQuickOpen(false);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.focus();
    }
  };

  const applyQuickReply = (text: string) => {
    setValue(text);
    setQuickOpen(false);
    requestAnimationFrame(() => {
      resize();
      textareaRef.current?.focus();
    });
  };

  // "/" numa caixa vazia abre as respostas rápidas, como nos apps de suporte.
  const filteredQuick =
    value.startsWith("/") && value.length > 1
      ? quickReplies.filter((reply) =>
          reply.toLowerCase().includes(value.slice(1).toLowerCase()),
        )
      : quickReplies;
  const showQuick = quickOpen || value === "/";

  return (
    <div className="shrink-0 border-t border-ivory-300 bg-ivory-100 dark:border-ink-800 dark:bg-ink-900">
      {attendant === "seller" ? (
        <p className="px-4 py-1.5 text-center text-[11px] text-ink-500 dark:text-ink-300">
          A {sellerName} está atendendo. Responder por aqui assume a conversa
          para você — ela para de responder nesta cliente.
        </p>
      ) : null}
      {showQuick && filteredQuick.length > 0 ? (
        <div
          role="listbox"
          aria-label="Respostas rápidas"
          className="flex gap-2 overflow-x-auto px-3 pt-2 [scrollbar-width:none]"
        >
          {filteredQuick.map((reply) => (
            <button
              key={reply}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => applyQuickReply(reply)}
              className="max-w-[260px] shrink-0 truncate rounded-full border border-ivory-300 bg-white px-3 py-1 text-xs text-ink-700 transition-colors hover:border-gold-500 hover:text-ink-900 motion-reduce:transition-none dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300 dark:hover:text-ivory-100"
            >
              {reply}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="flex items-end gap-2 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          onClick={() => setQuickOpen((open) => !open)}
          aria-label="Respostas rápidas"
          aria-expanded={showQuick}
          title="Respostas rápidas (ou digite /)"
          className={cx(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors motion-reduce:transition-none",
            showQuick
              ? "bg-gold-300/70 text-ink-900 dark:bg-gold-800/50 dark:text-gold-300"
              : "text-ink-500 hover:bg-ivory-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800",
          )}
        >
          <BoltIcon />
        </button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            resize();
          }}
          onKeyDown={(event) => {
            // Enter envia; Shift+Enter quebra linha; isComposing protege quem
            // digita com IME (acentuação por composição não pode enviar).
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
            if (event.key === "Escape") setQuickOpen(false);
          }}
          rows={1}
          maxLength={4000}
          placeholder="Escreva uma mensagem"
          aria-label="Mensagem para a cliente"
          className="max-h-[136px] min-w-0 flex-1 resize-none rounded-2xl border border-ivory-300 bg-white px-3.5 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-gold-500 focus:outline-none dark:border-ink-700 dark:bg-ink-800 dark:text-ivory-100 dark:placeholder:text-ink-400"
        />
        <button
          type="submit"
          disabled={value.trim().length === 0}
          aria-label="Enviar mensagem"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-900 text-ivory-50 transition-opacity disabled:opacity-40 motion-reduce:transition-none dark:bg-ivory-100 dark:text-ink-900"
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
