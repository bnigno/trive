"use client";

import { cx } from "@/components/ui/cx";
import { initialsFor, listTimestamp } from "./chat-format";
import {
  attendantBadge,
  conversationLabel,
  isSellerTyping,
  originPrefix,
  type AttendantBadge,
} from "./format";
import { MessageTicks } from "./ticks";
import type { ChatConversation } from "./use-chat-poll";

// Anel do avatar diz quem atende: dourado = a vendedora; âmbar = você;
// vermelho = ninguém (vendedora desligada); cinza = encerrada.
const RING_CLASSES: Record<AttendantBadge["tone"], string> = {
  success: "ring-gold-500",
  warning: "ring-amber-500",
  danger: "ring-red-400",
  info: "ring-sky-500",
  neutral: "ring-zinc-300 dark:ring-ink-700",
};

const CHIP_CLASSES: Record<AttendantBadge["tone"], string> = {
  success: "bg-gold-300/60 text-gold-800 dark:bg-gold-800/40 dark:text-gold-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  neutral: "bg-zinc-100 text-zinc-600 dark:bg-ink-800 dark:text-ink-300",
};

/** Cor do avatar derivada do telefone: a mesma cliente tem sempre a mesma. */
const AVATAR_PALETTE = [
  "bg-gold-300 text-ink-900",
  "bg-ivory-300 text-ink-900",
  "bg-laurel-600 text-ivory-50",
  "bg-claret-600 text-ivory-50",
  "bg-taupe-600 text-ivory-50",
  "bg-ink-700 text-ivory-50",
];

function avatarClass(phoneE164: string): string {
  let hash = 0;
  for (const char of phoneE164) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function ConversationItem({
  item,
  selected,
  onSelect,
  botEnabled,
  sellerName,
}: {
  item: ChatConversation;
  selected: boolean;
  onSelect: (id: string) => void;
  botEnabled: boolean;
  sellerName: string;
}) {
  const badge = attendantBadge(
    item.status,
    item.botDisabledUntil ? new Date(item.botDisabledUntil) : null,
    { botEnabled, sellerName },
  );
  const label = conversationLabel(item);
  const hasUnread = item.unreadCount > 0;
  const typing = isSellerTyping({
    attendant: badge.attendant,
    lastMessageDirection: item.lastMessageDirection,
    lastMessageAt: item.lastMessageAt,
  });
  const prefix = originPrefix(item.lastMessageOrigin, sellerName);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "flex w-full items-center gap-3 border-b border-ivory-200 px-3 py-2.5 text-left transition-colors motion-reduce:transition-none dark:border-ink-800/80",
          selected
            ? "bg-ivory-200 dark:bg-ink-800"
            : "hover:bg-ivory-100 dark:hover:bg-ink-900",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-semibold ring-2 ring-offset-2 ring-offset-ivory-50 dark:ring-offset-ink-950",
            item.isOwnerNotices ? "bg-ink-900 text-gold-300" : avatarClass(item.phoneE164),
            item.isOwnerNotices ? RING_CLASSES.neutral : RING_CLASSES[badge.tone],
          )}
        >
          {item.isOwnerNotices ? "★" : initialsFor(item.customerName ?? item.displayName, item.phoneE164)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cx(
                "truncate text-sm text-ink-900 dark:text-ivory-100",
                hasUnread ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </span>
            <span
              className={cx(
                "shrink-0 text-[11px] tabular-nums",
                hasUnread
                  ? "font-semibold text-gold-700 dark:text-gold-400"
                  : "text-ink-400 dark:text-ink-400",
              )}
            >
              {item.lastMessageAt ? listTimestamp(item.lastMessageAt) : ""}
            </span>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 text-xs text-ink-500 dark:text-ink-300">
              {typing ? (
                <span className="flex items-center gap-1 italic text-gold-700 dark:text-gold-400">
                  <TypingDots />
                  {sellerName} respondendo…
                </span>
              ) : (
                <>
                  {item.lastMessageDirection === "outbound" ? (
                    <span aria-hidden="true" className="shrink-0 text-ink-400">
                      <MessageTicks status="delivered" />
                    </span>
                  ) : null}
                  {prefix ? (
                    <span className="shrink-0 font-medium text-ink-700 dark:text-ink-300">
                      {prefix}:
                    </span>
                  ) : null}
                  <span className="truncate">{item.lastMessagePreview ?? "—"}</span>
                </>
              )}
            </span>
            {hasUnread ? (
              <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-gold-600 px-1.5 text-[11px] font-semibold text-white">
                {item.unreadCount}
                <span className="sr-only"> mensagens não lidas</span>
              </span>
            ) : item.isOwnerNotices ? null : (
              <span
                className={cx(
                  "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
                  CHIP_CLASSES[badge.tone],
                )}
              >
                {badge.attendant === "you" ? "Você" : badge.attendant === "seller" ? sellerName : badge.label}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

export function TypingDots() {
  return (
    <span aria-hidden="true" className="inline-flex items-end gap-0.5">
      <span className="wa-typing-dot h-1 w-1 rounded-full bg-current" />
      <span className="wa-typing-dot h-1 w-1 rounded-full bg-current [animation-delay:150ms]" />
      <span className="wa-typing-dot h-1 w-1 rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}
