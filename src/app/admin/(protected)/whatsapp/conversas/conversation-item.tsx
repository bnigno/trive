"use client";

import { cx } from "@/components/ui/cx";
import { initialsFor, listTimestamp } from "./chat-format";
import { attendantBadge, maskPhone } from "./format";
import { DoubleCheckIcon } from "./ticks";
import type { ChatConversation } from "./use-chat-poll";

// Ponto de status do atendimento ao lado do nome, na cor do badge da thread.
const DOT_CLASSES: Record<string, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-zinc-400",
};

export function ConversationItem({
  item,
  selected,
  onSelect,
}: {
  item: ChatConversation;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const badge = attendantBadge(
    item.status,
    item.botDisabledUntil ? new Date(item.botDisabledUntil) : null,
  );
  const name = item.customerName ?? maskPhone(item.phoneE164);
  const hasUnread = item.unreadCount > 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "flex w-full items-center gap-3 border-b border-zinc-100 px-3 py-2.5 text-left transition-colors motion-reduce:transition-none dark:border-zinc-800/60",
          selected
            ? "bg-zinc-200/70 dark:bg-zinc-800"
            : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
        )}
      >
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-zinc-300 text-sm font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
        >
          {initialsFor(item.customerName, item.phoneE164)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                title={badge.label}
                className={cx(
                  "h-2 w-2 shrink-0 rounded-full",
                  DOT_CLASSES[badge.tone] ?? DOT_CLASSES.neutral,
                )}
              />
              <span className="sr-only">{badge.label}.</span>
              <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {name}
              </span>
            </span>
            <span
              className={cx(
                "shrink-0 text-[11px]",
                hasUnread
                  ? "font-semibold text-[#25d366]"
                  : "text-zinc-500 dark:text-zinc-400",
              )}
            >
              {item.lastMessageAt ? listTimestamp(item.lastMessageAt) : ""}
            </span>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
              {item.lastMessageDirection === "outbound" ? (
                <span aria-hidden="true" className="shrink-0">
                  <DoubleCheckIcon />
                </span>
              ) : null}
              <span className="truncate">{item.lastMessagePreview ?? "—"}</span>
            </span>
            {hasUnread ? (
              <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[#25d366] px-1.5 text-[11px] font-semibold text-white">
                {item.unreadCount}
                <span className="sr-only"> mensagens não lidas</span>
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
