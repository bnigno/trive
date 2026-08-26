"use client";

import { cx } from "@/components/ui/cx";
import {
  isAwaitingReply,
  listTimestamp,
  senderInitials,
  senderLabel,
  subjectOrPlaceholder,
} from "./email-format";
import type { InboxThreadItem } from "./use-inbox-poll";

export function ThreadListItem({
  item,
  selected,
  onSelect,
}: {
  item: InboxThreadItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const who = senderLabel(item);
  const awaiting = isAwaitingReply(item);
  const subject = subjectOrPlaceholder(item.subject);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "flex w-full items-start gap-3 border-b border-zinc-100 px-3 py-3 text-left transition-colors motion-reduce:transition-none dark:border-zinc-800/60",
          selected
            ? "bg-indigo-50/70 dark:bg-indigo-950/40"
            : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold",
            awaiting
              ? "bg-indigo-600 text-white"
              : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
          )}
        >
          {senderInitials(who)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cx(
                "truncate text-sm text-zinc-900 dark:text-zinc-100",
                awaiting ? "font-semibold" : "font-medium",
              )}
            >
              {subject}
            </span>
            <span
              className={cx(
                "shrink-0 text-[11px]",
                awaiting
                  ? "font-semibold text-indigo-700 dark:text-indigo-300"
                  : "text-zinc-500 dark:text-zinc-400",
              )}
            >
              {item.lastMessageAt ? listTimestamp(item.lastMessageAt) : ""}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-zinc-600 dark:text-zinc-400">
            {item.lastMessageDirection === "outbound" ? "Você → " : ""}
            {who}
          </span>
          <span className="mt-1 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {item.lastMessageSnippet ?? "—"}
            </span>
            {awaiting ? (
              <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-semibold text-white">
                {item.unreadCount}
                <span className="sr-only"> e-mails ainda não abertos</span>
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
