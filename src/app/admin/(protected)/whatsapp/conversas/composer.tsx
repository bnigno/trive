"use client";

import { useEffect, useRef, useState } from "react";

// ~6 linhas de texto (20px de linha + padding) antes de rolar internamente.
const MAX_HEIGHT_PX = 136;

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
    </svg>
  );
}

export function Composer({
  showTakeoverNotice,
  onSend,
}: {
  /** status 'open': avisa que responder tira a conversa do robô. */
  showTakeoverNotice: boolean;
  onSend: (body: string) => void;
}) {
  const [value, setValue] = useState("");
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
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.focus();
    }
  };

  return (
    <div className="shrink-0 bg-[#f0f2f5] dark:bg-[#202c33]">
      {showTakeoverNotice ? (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
          Responder assume a conversa para você — o robô para de responder aqui.
        </p>
      ) : null}
      <form
        className="flex items-end gap-2 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
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
          }}
          rows={1}
          maxLength={4000}
          placeholder="Escreva uma mensagem"
          aria-label="Mensagem para o cliente"
          className="max-h-[136px] min-w-0 flex-1 resize-none rounded-lg bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 focus:outline-none dark:bg-[#2a3942] dark:text-zinc-100 dark:placeholder:text-zinc-400"
        />
        <button
          type="submit"
          disabled={value.trim().length === 0}
          aria-label="Enviar mensagem"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#00a884] text-white transition-opacity disabled:opacity-50 motion-reduce:transition-none"
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
