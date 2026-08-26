"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import {
  archiveEmailThreadAction,
  reopenEmailThreadAction,
  type ActionResult,
} from "./actions";
import { senderInitials, senderLabel, subjectOrPlaceholder } from "./email-format";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <path
        d="M15 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThreadHeader({
  threadId,
  subject,
  participantEmail,
  participantName,
  customerName,
  status,
  onBack,
  pollNow,
}: {
  threadId: string;
  subject: string;
  participantEmail: string;
  participantName: string | null;
  customerName: string | null;
  status: string;
  onBack: () => void;
  pollNow: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const who = senderLabel({ customerName, participantName, participantEmail });
  const archived = status === "archived";

  const runAction = (action: (threadId: string) => Promise<ActionResult>) => {
    setError(null);
    startTransition(async () => {
      const result = await action(threadId);
      if ("error" in result) setError(result.error);
      // Poll imediato: a lista e o cabeçalho acompanham a mudança sem esperar
      // o ciclo inteiro.
      pollNow();
    });
  };

  return (
    <div className="shrink-0">
      <header className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 md:px-4 dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          onClick={onBack}
          aria-label="Voltar para a lista de e-mails"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-200 motion-reduce:transition-none md:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <BackIcon />
        </button>
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-300 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
        >
          {senderInitials(who)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {subjectOrPlaceholder(subject)}
          </p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {who === participantEmail ? who : `${who} · ${participantEmail}`}
          </p>
        </div>
        <Badge tone={archived ? "neutral" : "info"}>
          {archived ? "Arquivada" : "Na caixa de entrada"}
        </Badge>
        <button
          type="button"
          onClick={() =>
            runAction(
              archived ? reopenEmailThreadAction : archiveEmailThreadAction,
            )
          }
          disabled={isPending}
          className="whitespace-nowrap rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {archived
            ? isPending
              ? "Reabrindo…"
              : "Reabrir"
            : isPending
              ? "Arquivando…"
              : "Arquivar"}
        </button>
      </header>
      {error ? (
        <p
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
