"use client";

import Link from "next/link";

import { cx } from "@/components/ui/cx";
import { ConversationItem } from "./conversation-item";
import type { ChatConversation } from "./use-chat-poll";

export type ConversationFilter = "all" | "you" | "seller" | "unread" | "closed";

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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: "all", label: "Todas" },
  { key: "you", label: "Com você" },
  { key: "seller", label: "Com a vendedora" },
  { key: "unread", label: "Não lidas" },
  { key: "closed", label: "Encerradas" },
];

export function ConversationList({
  conversations,
  totalLoaded,
  counts,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  botEnabled,
  sellerName,
}: {
  conversations: ChatConversation[];
  totalLoaded: number;
  counts: Record<ConversationFilter, number>;
  filter: ConversationFilter;
  onFilterChange: (filter: ConversationFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  botEnabled: boolean;
  sellerName: string;
}) {
  const searching = query.trim() !== "";

  return (
    <div className="flex h-full min-h-0 flex-col bg-ivory-50 dark:bg-ink-950">
      <header className="shrink-0 border-b border-ivory-300 px-3 pb-2 pt-3 dark:border-ink-800">
        <div className="flex items-center justify-between gap-2 px-1">
          <h1 className="font-serif text-lg font-medium tracking-wide text-ink-900 dark:text-ivory-100">
            Conversas
          </h1>
          <Link
            href="/admin/whatsapp"
            aria-label="Central do WhatsApp"
            title="Central do WhatsApp"
            className="grid h-8 w-8 place-items-center rounded-full text-ink-500 transition-colors hover:bg-ivory-200 hover:text-ink-900 motion-reduce:transition-none dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ivory-100"
          >
            <GearIcon />
          </Link>
        </div>
        <label className="mt-2 flex items-center gap-2 rounded-full border border-ivory-300 bg-white px-3 py-1.5 text-ink-500 focus-within:border-gold-500 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Buscar por nome ou telefone"
            aria-label="Buscar conversas"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none dark:text-ivory-100"
          />
        </label>
        <div
          role="group"
          aria-label="Filtrar conversas"
          className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]"
        >
          {FILTERS.map(({ key, label }) => {
            const active = filter === key;
            const count = counts[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => onFilterChange(key)}
                className={cx(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none",
                  active
                    ? "border-ink-900 bg-ink-900 text-ivory-50 dark:border-ivory-100 dark:bg-ivory-100 dark:text-ink-900"
                    : "border-ivory-300 bg-white text-ink-700 hover:border-ink-400 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300 dark:hover:border-ink-400",
                )}
              >
                {label}
                {count > 0 ? (
                  <span
                    className={cx(
                      "rounded-full px-1.5 text-[10px] tabular-nums",
                      active
                        ? "bg-ivory-50/20 text-ivory-50 dark:bg-ink-900/15 dark:text-ink-900"
                        : key === "you" && count > 0
                          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                          : "bg-ivory-200 text-ink-700 dark:bg-ink-800 dark:text-ink-300",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>
      {conversations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink-700 dark:text-ink-300">
            {searching
              ? "Nenhuma conversa com esse nome ou telefone."
              : totalLoaded === 0
                ? "Nenhuma conversa ainda."
                : "Nada por aqui neste filtro."}
          </p>
          <p className="max-w-xs text-xs text-ink-500 dark:text-ink-400">
            {searching
              ? "Só as 100 conversas mais recentes entram na busca."
              : totalLoaded === 0
                ? "Quando uma cliente mandar mensagem para o WhatsApp da loja, ela aparece aqui — e a vendedora responde sozinha."
                : `Troque o filtro acima para ver as outras${botEnabled ? "" : ` — a ${sellerName} está desligada, então tudo cai com você`}.`}
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {conversations.map((item) => (
            <ConversationItem
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={onSelect}
              botEnabled={botEnabled}
              sellerName={sellerName}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
