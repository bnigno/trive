"use client";

import Link from "next/link";

import { ConversationItem } from "./conversation-item";
import type { ChatConversation } from "./use-chat-poll";

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.8l1.2 2.4 2.6.5 1.9-1 1.6 1.6-1 1.9.5 2.6 2.4 1.2-2.4 1.2-.5 2.6 1 1.9-1.6 1.6-1.9-1-2.6.5L12 21.2l-1.2-2.4-2.6-.5-1.9 1-1.6-1.6 1-1.9-.5-2.6L2.8 12l2.4-1.2.5-2.6-1-1.9 1.6-1.6 1.9 1 2.6-.5L12 2.8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: ChatConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Conversas
        </h1>
        <Link
          href="/admin/whatsapp"
          aria-label="Configurações do WhatsApp"
          className="grid h-8 w-8 place-items-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-200 motion-reduce:transition-none dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <GearIcon />
        </Link>
      </header>
      {conversations.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
          Nenhuma conversa ainda — quando um cliente mandar mensagem para o
          WhatsApp da loja, ela aparece aqui.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {conversations.map((item) => (
            <ConversationItem
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
