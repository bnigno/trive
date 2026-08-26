"use client";

import { Composer } from "./composer";
import { senderLabel } from "./email-format";
import { MessageList, type OptimisticDisplay } from "./message-list";
import { ThreadHeader } from "./thread-header";
import type { InboxMessage } from "./use-inbox-poll";

function ThreadSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 md:px-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="h-9 w-9 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
        <div className="flex flex-col gap-1.5">
          <div className="h-3 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-2.5 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 bg-zinc-100 p-4 dark:bg-zinc-950">
        <div className="h-24 animate-pulse rounded-lg bg-white/80 dark:bg-zinc-900" />
        <div className="h-20 animate-pulse rounded-lg bg-white/80 dark:bg-zinc-900" />
        <div className="h-28 animate-pulse rounded-lg bg-white/80 dark:bg-zinc-900" />
      </div>
    </div>
  );
}

export function ThreadPanel({
  selectedId,
  subject,
  participantEmail,
  participantName,
  customerName,
  status,
  loaded,
  missing,
  messages,
  optimistic,
  scrollSignal,
  onSend,
  onRetry,
  onBack,
  pollNow,
}: {
  selectedId: string | null;
  subject: string;
  participantEmail: string;
  participantName: string | null;
  customerName: string | null;
  status: string;
  /** Já temos a conversa (servidor ou primeiro poll)? Senão, esqueleto. */
  loaded: boolean;
  /** O poll respondeu que a conversa não existe. */
  missing: boolean;
  messages: InboxMessage[];
  optimistic: OptimisticDisplay[];
  scrollSignal: number;
  onSend: (body: string) => void;
  onRetry: (tempId: string) => void;
  onBack: () => void;
  pollNow: () => void;
}) {
  if (!selectedId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-zinc-50 px-6 text-center dark:bg-zinc-900/40">
        <p className="text-base font-medium text-zinc-700 dark:text-zinc-300">
          Escolha um e-mail
        </p>
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          Selecione uma conversa na lista ao lado para ler a mensagem inteira,
          baixar anexos e responder.
        </p>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-50 px-6 text-center dark:bg-zinc-900/40">
        <p className="text-base font-medium text-zinc-700 dark:text-zinc-300">
          Conversa não encontrada
        </p>
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          Ela pode ter sido removida. Volte para a lista e escolha outra.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Ver todos os e-mails
        </button>
      </div>
    );
  }

  if (!loaded && messages.length === 0) {
    return <ThreadSkeleton />;
  }

  const senderName = senderLabel({
    customerName,
    participantName,
    participantEmail,
  });
  // A citação recolhida do composer é a ÚLTIMA mensagem recebida: é a ela que
  // o dono está respondendo.
  const lastInbound =
    [...messages].reverse().find((m) => m.direction === "inbound") ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader
        threadId={selectedId}
        subject={subject}
        participantEmail={participantEmail}
        participantName={participantName}
        customerName={customerName}
        status={status}
        onBack={onBack}
        pollNow={pollNow}
      />
      <MessageList
        key={selectedId}
        messages={messages}
        optimistic={optimistic}
        senderName={senderName}
        participantEmail={participantEmail}
        threadSubject={subject}
        scrollSignal={scrollSignal}
        onRetry={onRetry}
      />
      {status === "archived" ? (
        <p className="shrink-0 border-t border-zinc-200 bg-zinc-100 px-4 py-3 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Conversa arquivada. Use “Reabrir”, lá em cima, para voltar a
          responder.
        </p>
      ) : (
        <Composer
          key={`composer-${selectedId}`}
          subject={subject}
          quotedFrom={lastInbound ? senderName : null}
          quotedText={lastInbound?.textBody ?? ""}
          quotedAt={lastInbound?.createdAt ?? null}
          onSend={onSend}
        />
      )}
    </div>
  );
}
