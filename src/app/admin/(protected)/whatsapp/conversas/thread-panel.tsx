"use client";

import { Composer } from "./composer";
import { MessageList, type OptimisticDisplay } from "./message-list";
import { ThreadHeader } from "./thread-header";
import type { ChatMessage } from "./use-chat-poll";

function ThreadSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 md:px-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="h-9 w-9 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
        <div className="flex flex-col gap-1.5">
          <div className="h-3 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 bg-[#efeae2] p-4 dark:bg-[#0b141a]">
        <div className="h-10 w-1/2 animate-pulse self-start rounded-lg bg-white/70 dark:bg-[#202c33]" />
        <div className="h-10 w-2/5 animate-pulse self-end rounded-lg bg-[#d9fdd3]/70 dark:bg-[#005c4b]/60" />
        <div className="h-14 w-3/5 animate-pulse self-start rounded-lg bg-white/70 dark:bg-[#202c33]" />
        <div className="h-10 w-1/3 animate-pulse self-end rounded-lg bg-[#d9fdd3]/70 dark:bg-[#005c4b]/60" />
      </div>
    </div>
  );
}

export function ThreadPanel({
  selectedId,
  customerName,
  phoneE164,
  status,
  botDisabledUntil,
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
  customerName: string | null;
  phoneE164: string;
  status: string;
  botDisabledUntil: string | null;
  /** Já temos dados da thread (SSR ou primeiro poll)? Senão, skeleton. */
  loaded: boolean;
  /** O poll respondeu que a conversa não existe. */
  missing: boolean;
  messages: ChatMessage[];
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
          Escolha uma conversa
        </p>
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          Selecione uma conversa na lista ao lado para ler as mensagens,
          assumir o atendimento ou responder na mão.
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
          Ver todas as conversas
        </button>
      </div>
    );
  }

  if (!loaded && messages.length === 0) {
    return <ThreadSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader
        conversationId={selectedId}
        customerName={customerName}
        phoneE164={phoneE164}
        status={status}
        botDisabledUntil={botDisabledUntil}
        onBack={onBack}
        pollNow={pollNow}
      />
      <MessageList
        key={selectedId}
        messages={messages}
        optimistic={optimistic}
        scrollSignal={scrollSignal}
        onRetry={onRetry}
      />
      {status === "closed" ? (
        <p className="shrink-0 bg-zinc-100 px-4 py-3 text-center text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          Conversa encerrada — não dá para responder por aqui.
        </p>
      ) : (
        <Composer
          key={`composer-${selectedId}`}
          showTakeoverNotice={status === "open"}
          onSend={onSend}
        />
      )}
    </div>
  );
}
