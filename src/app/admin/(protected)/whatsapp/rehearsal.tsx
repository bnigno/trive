"use client";

// "Testar a vendedora": uma conversa de ensaio com o prompt e o catálogo
// reais, sem WhatsApp, sem pedido e sem cobrança além dos centavos da API.
// O dono sente o tom antes de salvar as instruções extras.
import { useRef, useState, useTransition } from "react";

import { cx } from "@/components/ui/cx";
import { rehearseBotAction } from "./actions";
import { describeTools } from "./conversas/format";

type Bubble =
  | { kind: "user"; text: string }
  | {
      kind: "seller";
      texts: string[];
      attachments: string[];
      tools: string;
      handedOff: boolean;
      durationMs: number;
    };

const SUGGESTIONS = [
  "oi",
  "quero um vestido pra um casamento de dia",
  "vocês são robô?",
  "quanto custa a peça mais barata?",
  "posso trocar se não servir?",
];

export function Rehearsal({ sellerName }: { sellerName: string }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [history, setHistory] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const send = (raw: string) => {
    const message = raw.trim();
    if (!message || isPending) return;
    setError(null);
    setValue("");
    setBubbles((prev) => [...prev, { kind: "user", text: message }]);
    startTransition(async () => {
      const result = await rehearseBotAction({ history, message });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const { turn } = result;
      setBubbles((prev) => [
        ...prev,
        {
          kind: "seller",
          texts: turn.bubbles,
          attachments: turn.attachments.map((attachment) =>
            attachment.kind === "option_list"
              ? `📋 Lista tocável «${attachment.buttonLabel}» com ${attachment.options.length} ${attachment.options.length === 1 ? "opção" : "opções"}: ${attachment.options.map((option) => option.title).join(" · ")}`
              : `🖼️ Foto: ${attachment.caption}`,
          ),
          tools: describeTools(turn.toolCalls.map((call) => call.name)) ?? "",
          handedOff: turn.handedOff,
          durationMs: turn.durationMs,
        },
      ]);
      setHistory((prev) => [
        ...prev,
        { role: "user", text: message },
        ...(turn.bubbles.length > 0
          ? [{ role: "assistant" as const, text: turn.bubbles.join("\n\n") }]
          : []),
      ]);
      inputRef.current?.focus();
    });
  };

  const reset = () => {
    setBubbles([]);
    setHistory([]);
    setError(null);
    setValue("");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="wa-paper flex max-h-[420px] min-h-[220px] flex-col gap-2 overflow-y-auto rounded-lg border border-ivory-300 p-4 dark:border-ink-800">
        {bubbles.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-ink-700 dark:text-ink-300">
              Converse com a {sellerName} como se fosse uma cliente. Nada aqui
              vira pedido nem aviso de verdade.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => send(suggestion)}
                  className="rounded-full border border-ivory-300 bg-white px-3 py-1 text-xs text-ink-700 hover:border-gold-500 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {bubbles.map((bubble, index) =>
          bubble.kind === "user" ? (
            <div key={index} className="flex justify-start">
              <div className="wa-tail-in relative max-w-[85%] rounded-xl rounded-tl-none border border-ivory-300 bg-white px-3 py-1.5 text-sm text-ink-900 shadow-sm dark:border-ink-700 dark:bg-ink-800 dark:text-ivory-100">
                {bubble.text}
              </div>
            </div>
          ) : (
            <div key={index} className="flex flex-col items-end gap-1">
              {bubble.attachments.map((attachment) => (
                <p
                  key={attachment}
                  className="max-w-[85%] rounded-lg border border-dashed border-gold-500/60 bg-gold-300/20 px-3 py-1.5 text-[11px] text-ink-700 dark:text-gold-300"
                >
                  {attachment}
                </p>
              ))}
              {bubble.texts.map((text, i) => (
                <div
                  key={i}
                  className={cx(
                    "relative max-w-[85%] rounded-xl bg-ink-900 px-3 py-1.5 text-sm text-ivory-50 shadow-sm dark:bg-ivory-100 dark:text-ink-900",
                    i === 0 && "wa-tail-out rounded-tr-none",
                  )}
                >
                  {i === 0 ? (
                    <p className="text-[11px] font-semibold text-gold-400 dark:text-gold-700">
                      {sellerName}
                    </p>
                  ) : null}
                  <p className="whitespace-pre-wrap break-words">{text}</p>
                </div>
              ))}
              <p className="text-[11px] italic text-ink-400">
                {bubble.tools ? `${sellerName} ${bubble.tools} · ` : ""}
                {(bubble.durationMs / 1000).toFixed(1)} s
                {bubble.handedOff ? " · passaria para você" : ""}
              </p>
            </div>
          ),
        )}
        {isPending ? (
          <p className="text-right text-[11px] italic text-ink-400">
            {sellerName} está respondendo…
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send(value);
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`Escreva como uma cliente para a ${sellerName}`}
          aria-label="Mensagem de ensaio"
          maxLength={1000}
          className="min-w-0 flex-1 rounded-full border border-ivory-300 bg-white px-4 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-gold-500 focus:outline-none dark:border-ink-700 dark:bg-ink-800 dark:text-ivory-100"
        />
        <button
          type="submit"
          disabled={isPending || value.trim() === ""}
          className="rounded-full bg-ink-900 px-4 py-2 text-sm font-medium text-ivory-50 disabled:opacity-40 dark:bg-ivory-100 dark:text-ink-900"
        >
          Enviar
        </button>
        {bubbles.length > 0 ? (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400"
          >
            Recomeçar
          </button>
        ) : null}
      </form>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
        Cada mensagem usa a inteligência real (centavos de dólar). O ensaio não
        tem caderninho nem cadastro: é sempre uma cliente nova.
      </p>
    </div>
  );
}
