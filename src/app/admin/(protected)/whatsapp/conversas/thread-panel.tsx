"use client";

import { cx } from "@/components/ui/cx";
import { Composer } from "./composer";
import { ContextPanel } from "./context-panel";
import { attendantBadge, isSellerTyping } from "./format";
import { MessageList, type OptimisticDisplay } from "./message-list";
import { ThreadHeader } from "./thread-header";
import type { ChatActivity, ChatContext, ChatMessage } from "./use-chat-poll";

function ThreadSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="flex items-center gap-2 border-b border-ivory-300 bg-ivory-50 px-3 py-2 md:px-4 dark:border-ink-800 dark:bg-ink-950">
        <div className="h-9 w-9 animate-pulse rounded-full bg-ivory-300 dark:bg-ink-800" />
        <div className="flex flex-col gap-1.5">
          <div className="h-3 w-32 animate-pulse rounded bg-ivory-300 dark:bg-ink-800" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-ivory-300 dark:bg-ink-800" />
        </div>
      </div>
      <div className="wa-paper flex min-h-0 flex-1 flex-col gap-2 p-4">
        <div className="h-10 w-1/2 animate-pulse self-start rounded-xl bg-white/80 dark:bg-ink-800" />
        <div className="h-10 w-2/5 animate-pulse self-end rounded-xl bg-ink-900/70 dark:bg-ivory-100/60" />
        <div className="h-14 w-3/5 animate-pulse self-start rounded-xl bg-white/80 dark:bg-ink-800" />
        <div className="h-10 w-1/3 animate-pulse self-end rounded-xl bg-ink-900/70 dark:bg-ivory-100/60" />
      </div>
    </div>
  );
}

export function ThreadPanel({
  selectedId,
  customerName,
  displayName,
  isOwnerNotices,
  phoneE164,
  status,
  botDisabledUntil,
  botEnabled,
  sellerName,
  loaded,
  missing,
  messages,
  optimistic,
  context,
  activity,
  quickReplies,
  scrollSignal,
  contextOpen,
  onToggleContext,
  onSend,
  onRetry,
  onBack,
  onClose,
  pollNow,
}: {
  selectedId: string | null;
  customerName: string | null;
  displayName: string | null;
  isOwnerNotices: boolean;
  phoneE164: string;
  status: string;
  botDisabledUntil: string | null;
  botEnabled: boolean;
  sellerName: string;
  /** Já temos dados da thread (SSR ou primeiro poll)? Senão, skeleton. */
  loaded: boolean;
  /** O poll respondeu que a conversa não existe. */
  missing: boolean;
  messages: ChatMessage[];
  optimistic: OptimisticDisplay[];
  context: ChatContext | null;
  activity: ChatActivity[];
  quickReplies: string[];
  scrollSignal: number;
  contextOpen: boolean;
  onToggleContext: () => void;
  onSend: (body: string) => void;
  onRetry: (tempId: string) => void;
  onBack: () => void;
  onClose: (conversationId: string) => Promise<string | null>;
  pollNow: () => void;
}) {
  if (!selectedId) {
    return (
      <div className="wa-paper flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span
          aria-hidden="true"
          className="font-serif text-4xl tracking-[0.3em] text-gold-600 dark:text-gold-400"
        >
          TRIVÉ
        </span>
        <p className="text-base font-medium text-ink-800 dark:text-ivory-100">
          Escolha uma conversa
        </p>
        <p className="max-w-sm text-sm text-ink-500 dark:text-ink-300">
          {botEnabled
            ? `A ${sellerName} atende sozinha; você entra quando quiser — ou quando ela passar uma cliente para você.`
            : `A ${sellerName} está desligada: toda mensagem nova cai com você. Ligue-a na Central do WhatsApp quando quiser.`}
        </p>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ivory-50 px-6 text-center dark:bg-ink-950">
        <p className="text-base font-medium text-ink-800 dark:text-ivory-100">
          Conversa não encontrada
        </p>
        <p className="max-w-sm text-sm text-ink-500 dark:text-ink-300">
          Ela pode ter sido removida. Volte para a lista e escolha outra.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-ivory-300 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ivory-100 motion-reduce:transition-none dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800"
        >
          Ver todas as conversas
        </button>
      </div>
    );
  }

  if (!loaded && messages.length === 0) {
    return <ThreadSkeleton />;
  }

  const badge = attendantBadge(
    status,
    botDisabledUntil ? new Date(botDisabledUntil) : null,
    { botEnabled, sellerName },
  );
  const last = messages[messages.length - 1] ?? null;
  const sellerTyping =
    optimistic.length === 0 &&
    isSellerTyping({
      attendant: badge.attendant,
      lastMessageDirection: last?.direction ?? null,
      lastMessageAt: last?.createdAt ?? null,
    });
  const handoffBanner =
    status === "human" && context?.handoff ? context.handoff : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader
        conversationId={selectedId}
        customerName={customerName}
        displayName={displayName}
        isOwnerNotices={isOwnerNotices}
        phoneE164={phoneE164}
        status={status}
        botDisabledUntil={botDisabledUntil}
        botEnabled={botEnabled}
        sellerName={sellerName}
        contextOpen={contextOpen}
        onToggleContext={onToggleContext}
        onBack={onBack}
        onClose={onClose}
        pollNow={pollNow}
      />
      <div className="relative grid min-h-0 flex-1 xl:grid-cols-[1fr_300px]">
        <div className="flex min-h-0 min-w-0 flex-col">
          {handoffBanner ? (
            <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              <p>
                <span className="font-semibold">{sellerName} passou para você:</span>{" "}
                {handoffBanner.motivo}
              </p>
              {handoffBanner.resumo ? (
                <p className="mt-0.5 whitespace-pre-wrap opacity-90">{handoffBanner.resumo}</p>
              ) : null}
            </div>
          ) : null}
          <MessageList
            key={selectedId}
            messages={messages}
            optimistic={optimistic}
            activity={activity}
            sellerName={sellerName}
            sellerTyping={sellerTyping}
            scrollSignal={scrollSignal}
            onRetry={onRetry}
          />
          {status === "closed" ? (
            <p className="shrink-0 border-t border-ivory-300 bg-ivory-100 px-4 py-3 text-center text-xs text-ink-500 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300">
              Conversa encerrada — se a cliente escrever de novo, uma conversa
              nova aparece na lista.
            </p>
          ) : (
            <Composer
              key={`composer-${selectedId}`}
              attendant={badge.attendant}
              sellerName={sellerName}
              quickReplies={quickReplies}
              onSend={onSend}
            />
          )}
        </div>
        <aside
          aria-label="Informações da cliente"
          className={cx(
            "min-h-0 overflow-y-auto border-ivory-300 bg-ivory-50 dark:border-ink-800 dark:bg-ink-950",
            // Coluna fixa em telas largas; nas menores, uma folha sobre a thread.
            "xl:block xl:border-l",
            contextOpen
              ? "absolute inset-0 z-10 block border-t xl:static xl:border-t-0"
              : "hidden",
          )}
        >
          <ContextPanel
            context={context}
            phoneE164={phoneE164}
            isOwnerNotices={isOwnerNotices}
            sellerName={sellerName}
          />
        </aside>
      </div>
    </div>
  );
}
