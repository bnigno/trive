"use client";

// Copiloto: o cartão da sugestão da Lia acima da caixa de resposta — os
// balões como ela mandaria, chips dos anexos, e Enviar / Editar e enviar /
// Descartar. O envio sai pela fila como mensagem da Lia; o poll de 3 s
// recolhe o cartão quando a decisão chega ao servidor.
import { useEffect, useState, useTransition } from "react";

import { suggestionAgeLabel } from "@/core/bot/copilot";
import { approveSuggestionAction, discardSuggestionAction } from "./actions";
import { describeTools } from "./format";
import type { ChatSuggestion } from "./use-chat-poll";

export function SuggestionCard({ suggestion, sellerName, pollNow }: { suggestion: ChatSuggestion; sellerName: string; pollNow: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => suggestion.bubbles.join("\n\n"));
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<"sent" | "discarded" | null>(null);
  const [isPending, startTransition] = useTransition();
  // A idade anda: um tique por minuto (o React Compiler recusa relógio no render).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const run = (action: () => Promise<{ ok: true } | { error: string }>, outcome: "sent" | "discarded") => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDecided(outcome);
      pollNow();
    });
  };

  if (decided) {
    return (
      <p className="shrink-0 border-t border-sky-200 bg-sky-50 px-4 py-2 text-center text-[11px] text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        {decided === "sent" ? `Enviando como ${sellerName}…` : "Sugestão descartada."}
      </p>
    );
  }

  const described = describeTools(suggestion.toolCalls);

  return (
    <div className="shrink-0 border-t border-sky-200 bg-sky-50 px-4 py-3 text-sm text-ink-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-ivory-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-sky-900 dark:text-sky-200">
          💡 {sellerName} sugere {suggestion.fromFollowup ? "(retorno combinado)" : ""}
          <span className="ml-2 font-normal text-sky-800/70 dark:text-sky-300/70">{suggestionAgeLabel(new Date(suggestion.createdAt), now)}</span>
        </p>
      </div>
      {suggestion.attachments.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {suggestion.attachments.map((attachment, index) => (
            <div key={`${attachment.kind}-${index}`} className="rounded-md border border-sky-200 bg-white/70 px-2.5 py-1.5 text-[12px] text-ink-800 dark:border-sky-900 dark:bg-ink-900 dark:text-ivory-100">
              <p className="font-medium">{attachment.kind === "lista" ? `📋 Lista tocável · ${attachment.title}` : "🖼 Foto (vai antes do texto)"}</p>
              {attachment.lines.map((line, lineIndex) => (
                <p key={lineIndex} className="whitespace-pre-wrap text-ink-600 dark:text-ink-300">
                  {line}
                </p>
              ))}
              {attachment.url ? (
                <a href={attachment.url} target="_blank" rel="noreferrer" className="text-sky-800 underline dark:text-sky-300">
                  ver a foto
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {suggestion.inboundPreview ? (
        <p className="mt-1 truncate text-[11px] text-ink-500 dark:text-ink-300">Respondendo a: “{suggestion.inboundPreview}”</p>
      ) : null}
      {described ? <p className="mt-0.5 text-[11px] italic text-ink-500 dark:text-ink-300">{sellerName} {described}</p> : null}

      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            maxLength={1200}
            className="mt-2 w-full resize-y rounded-md border border-sky-300 bg-white p-2 text-sm text-ink-900 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-sky-800 dark:bg-ink-900 dark:text-ivory-100"
          />
          <p className="mt-1 text-[11px] text-ink-500 dark:text-ink-300">
            {draft.length}/1200{suggestion.attachments.length > 0 ? " · editada, a mensagem vai SEM a lista/foto da Lia — ajuste o texto se ele falava dela." : ""}
          </p>
        </>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {suggestion.bubbles.map((bubble, index) => (
            <p key={index} className="whitespace-pre-wrap rounded-xl rounded-br-sm bg-white px-3 py-2 text-sm shadow-sm dark:bg-ink-900">
              {bubble}
            </p>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={isPending || draft.trim() === ""}
              onClick={() => run(() => approveSuggestionAction(suggestion.id, draft), "sent")}
              className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              {isPending ? "Enviando…" : "Enviar editada"}
            </button>
            <button type="button" disabled={isPending} onClick={() => setEditing(false)} className="rounded-md border border-sky-300 px-3 py-1.5 text-xs text-sky-900 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-800 dark:text-sky-200 dark:hover:bg-sky-900">
              Voltar
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => approveSuggestionAction(suggestion.id), "sent")}
              className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              {isPending ? "Enviando…" : "Enviar"}
            </button>
            <button type="button" disabled={isPending} onClick={() => setEditing(true)} className="rounded-md border border-sky-300 px-3 py-1.5 text-xs text-sky-900 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-800 dark:text-sky-200 dark:hover:bg-sky-900">
              Editar e enviar
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => discardSuggestionAction(suggestion.id), "discarded")}
              className="rounded-md px-3 py-1.5 text-xs text-ink-500 hover:bg-sky-100 disabled:opacity-50 dark:text-ink-300 dark:hover:bg-sky-900"
            >
              Descartar
            </button>
          </>
        )}
        {error ? <span className="text-[11px] text-red-700 dark:text-red-300">{error}</span> : null}
      </div>
    </div>
  );
}
