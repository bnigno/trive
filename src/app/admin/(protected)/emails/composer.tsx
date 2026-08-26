"use client";

import { useRef, useState } from "react";

import { messageTimestamp, replySubjectFor } from "./email-format";

// ~8 linhas antes de rolar por dentro: e-mail é texto mais longo que recado
// de WhatsApp, e a caixa começa maior por isso.
const MAX_HEIGHT_PX = 200;

export function Composer({
  subject,
  quotedFrom,
  quotedText,
  quotedAt,
  onSend,
}: {
  subject: string;
  /** Quem escreveu a mensagem citada; null quando não há nada a citar. */
  quotedFrom: string | null;
  quotedText: string;
  quotedAt: string | null;
  onSend: (body: string) => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="shrink-0 border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      <form
        className="mx-auto flex max-w-3xl flex-col gap-2 px-3 py-2.5 md:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* Assunto só de leitura de propósito: quem monta o assunto real é o
            serviço, a partir da conversa, e é isso que faz a resposta cair na
            mesma conversa na caixa do cliente. Um campo editável aqui
            prometeria uma escolha que o e-mail enviado ignoraria. */}
        <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="shrink-0 font-medium">Assunto</span>
          <input
            type="text"
            readOnly
            value={replySubjectFor(subject)}
            aria-describedby="assunto-ajuda"
            className="min-w-0 flex-1 cursor-default truncate rounded-md border border-zinc-200 bg-zinc-100 px-2 py-1 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
        </label>
        <p id="assunto-ajuda" className="sr-only">
          O assunto acompanha a conversa e não pode ser alterado aqui.
        </p>

        {quotedFrom ? (
          <details className="rounded-md border border-zinc-200 bg-white text-xs dark:border-zinc-700 dark:bg-zinc-950">
            <summary className="cursor-pointer px-2.5 py-1.5 text-zinc-600 dark:text-zinc-400">
              Respondendo a {quotedFrom}
              {quotedAt ? ` · ${messageTimestamp(quotedAt)}` : ""}
            </summary>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-t border-zinc-200 px-2.5 py-2 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              {quotedText.trim() || "(mensagem sem texto)"}
            </p>
          </details>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            resize();
          }}
          onKeyDown={(event) => {
            // Ao contrário do chat, Enter NÃO envia: resposta de e-mail tem
            // parágrafos, e enviar pela metade é o erro caro aqui. O atalho
            // fica em Ctrl+Enter (Cmd+Enter no Mac); isComposing protege quem
            // digita acento por composição (IME).
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          maxLength={10000}
          placeholder="Escreva sua resposta"
          aria-label="Resposta para o cliente"
          className="max-h-[200px] min-h-20 w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-400"
        />

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            A resposta entra na fila e sai em seguida — você acompanha o estado
            no cartão.
          </p>
          <button
            type="submit"
            disabled={value.trim().length === 0}
            className="shrink-0 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 motion-reduce:transition-none"
          >
            Responder
          </button>
        </div>
      </form>
    </div>
  );
}
