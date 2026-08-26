"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { useNotify } from "../../use-notify";
import {
  returnConversationToBotAction,
  takeOverConversationAction,
  type ActionResult,
} from "./actions";
import { initialsFor } from "./chat-format";
import { attendantBadge, maskPhone } from "./format";

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

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path
        d="M12 3a6 6 0 0 0-6 6v3.2l-1.4 2.8a.7.7 0 0 0 .63 1H18.8a.7.7 0 0 0 .62-1L18 12.2V9a6 6 0 0 0-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10 18.5a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NotifyPrefsPopover() {
  const { prefs, setPref } = useNotify();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper && !wrapper.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Preferências de aviso"
        aria-expanded={open}
        className="grid h-8 w-8 place-items-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-200 motion-reduce:transition-none dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <BellIcon />
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-10 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
            Avisos de mensagem nova
          </p>
          <label className="flex items-center justify-between gap-2 py-1 text-sm text-zinc-700 dark:text-zinc-300">
            Som
            <input
              type="checkbox"
              checked={prefs.sound}
              onChange={(event) => setPref("sound", event.target.checked)}
              className="h-4 w-4 accent-[#00a884]"
            />
          </label>
          <label className="flex items-center justify-between gap-2 py-1 text-sm text-zinc-700 dark:text-zinc-300">
            Notificações no computador
            <input
              type="checkbox"
              checked={prefs.desktop}
              onChange={(event) => setPref("desktop", event.target.checked)}
              className="h-4 w-4 accent-[#00a884]"
            />
          </label>
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            Ao ligar as notificações, o navegador pede permissão.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ThreadHeader({
  conversationId,
  customerName,
  phoneE164,
  status,
  botDisabledUntil,
  onBack,
  pollNow,
}: {
  conversationId: string;
  customerName: string | null;
  phoneE164: string;
  status: string;
  botDisabledUntil: string | null;
  onBack: () => void;
  pollNow: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const badge = attendantBadge(
    status,
    botDisabledUntil ? new Date(botDisabledUntil) : null,
  );
  const name = customerName ?? maskPhone(phoneE164);

  const runAction = (
    action: (conversationId: string) => Promise<ActionResult>,
  ) => {
    setError(null);
    startTransition(async () => {
      const result = await action(conversationId);
      if ("error" in result) setError(result.error);
      // Poll imediato: o status novo (e a mensagem de sistema, se houver)
      // aparece sem esperar os 3s.
      pollNow();
    });
  };

  return (
    <div className="shrink-0">
      <header className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 md:px-4 dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          onClick={onBack}
          aria-label="Voltar para a lista de conversas"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-200 motion-reduce:transition-none md:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <BackIcon />
        </button>
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-300 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
        >
          {initialsFor(customerName, phoneE164)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {name}
          </p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {maskPhone(phoneE164)}
          </p>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {status === "human" ? (
          <button
            type="button"
            onClick={() => runAction(returnConversationToBotAction)}
            disabled={isPending}
            className="whitespace-nowrap rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {isPending ? "Devolvendo…" : "Devolver ao robô"}
          </button>
        ) : null}
        {status === "open" ? (
          <button
            type="button"
            onClick={() => runAction(takeOverConversationAction)}
            disabled={isPending}
            className="whitespace-nowrap rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {isPending ? "Assumindo…" : "Assumir"}
          </button>
        ) : null}
        <NotifyPrefsPopover />
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
