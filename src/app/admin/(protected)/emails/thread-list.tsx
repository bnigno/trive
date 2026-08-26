"use client";

import { cx } from "@/components/ui/cx";
import { ThreadListItem } from "./thread-list-item";
import type { InboxBox, InboxThreadItem } from "./use-inbox-poll";

const TABS: Array<{ box: InboxBox; label: string }> = [
  { box: "open", label: "Caixa de entrada" },
  { box: "archived", label: "Arquivadas" },
];

const EMPTY_TEXT: Record<InboxBox, string> = {
  open: "Nenhum e-mail por aqui — quando alguém escrever para o endereço da loja, a mensagem aparece nesta lista.",
  archived:
    "Nada arquivado ainda. Ao arquivar uma conversa, ela sai da caixa de entrada e fica guardada aqui.",
};

export function ThreadList({
  threads,
  selectedId,
  box,
  onSelect,
  onBoxChange,
}: {
  threads: InboxThreadItem[];
  selectedId: string | null;
  box: InboxBox;
  onSelect: (id: string) => void;
  onBoxChange: (box: InboxBox) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          E-mails
        </h1>
        {/* Botões de filtro com aria-pressed, não role="tab": não existe um
            painel de abas aqui — trocar de caixa troca a lista inteira. */}
        <div aria-label="Qual caixa mostrar" className="mt-2 flex gap-1">
          {TABS.map((tab) => {
            const active = tab.box === box;
            return (
              <button
                key={tab.box}
                type="button"
                aria-pressed={active}
                onClick={() => onBoxChange(tab.box)}
                className={cx(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none",
                  active
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>
      {threads.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
          {EMPTY_TEXT[box]}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {threads.map((item) => (
            <ThreadListItem
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
