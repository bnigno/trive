"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
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

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 11v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5.5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="18.5" r="1.8" />
    </svg>
  );
}

const iconButton =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-500 transition-colors hover:bg-ivory-200 hover:text-ink-900 motion-reduce:transition-none dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ivory-100";

function useOutsideClose(open: boolean, close: () => void) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper && !wrapper.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);
  return wrapperRef;
}

function NotifyPrefsPopover() {
  const { prefs, setPref } = useNotify();
  const [open, setOpen] = useState(false);
  const wrapperRef = useOutsideClose(open, () => setOpen(false));

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Avisos de mensagem nova"
        aria-expanded={open}
        className={iconButton}
      >
        <BellIcon />
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-10 w-64 rounded-lg border border-ivory-300 bg-white p-3 shadow-lg dark:border-ink-700 dark:bg-ink-900">
          <p className="mb-2 text-xs font-semibold text-ink-900 dark:text-ivory-100">
            Avisos de mensagem nova
          </p>
          <label className="flex items-center justify-between gap-2 py-1 text-sm text-ink-700 dark:text-ink-300">
            Som
            <input
              type="checkbox"
              checked={prefs.sound}
              onChange={(event) => setPref("sound", event.target.checked)}
              className="h-4 w-4 accent-gold-600"
            />
          </label>
          <label className="flex items-center justify-between gap-2 py-1 text-sm text-ink-700 dark:text-ink-300">
            Avisos do navegador
            <input
              type="checkbox"
              checked={prefs.desktop}
              onChange={(event) => setPref("desktop", event.target.checked)}
              className="h-4 w-4 accent-gold-600"
            />
          </label>
          <p className="mt-1 text-[11px] text-ink-500 dark:text-ink-400">
            Ao ligar os avisos, o navegador pede permissão. No celular, o aviso
            também chega no seu WhatsApp.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ThreadHeader({
  conversationId,
  customerName,
  displayName,
  isOwnerNotices,
  phoneE164,
  status,
  botDisabledUntil,
  botEnabled,
  sellerName,
  contextOpen,
  onToggleContext,
  onBack,
  onClose,
  pollNow,
}: {
  conversationId: string;
  customerName: string | null;
  displayName: string | null;
  isOwnerNotices: boolean;
  phoneE164: string;
  status: string;
  botDisabledUntil: string | null;
  botEnabled: boolean;
  sellerName: string;
  contextOpen: boolean;
  onToggleContext: () => void;
  onBack: () => void;
  onClose: (conversationId: string) => Promise<string | null>;
  pollNow: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const menuRef = useOutsideClose(menuOpen, () => setMenuOpen(false));

  const badge = attendantBadge(
    status,
    botDisabledUntil ? new Date(botDisabledUntil) : null,
    { botEnabled, sellerName },
  );
  const name = isOwnerNotices
    ? "Avisos internos"
    : (customerName ?? displayName ?? maskPhone(phoneE164));
  const subtitle = isOwnerNotices
    ? "o seu próprio WhatsApp"
    : customerName || displayName
      ? maskPhone(phoneE164)
      : null;

  const runAction = (
    action: (conversationId: string) => Promise<ActionResult>,
  ) => {
    setError(null);
    setMenuOpen(false);
    startTransition(async () => {
      const result = await action(conversationId);
      if ("error" in result) setError(result.error);
      // Poll imediato: o status novo (e a mensagem de sistema, se houver)
      // aparece sem esperar os 3s.
      pollNow();
    });
  };

  const returnToSeller = () => {
    if (
      !window.confirm(
        `Devolver a conversa para a ${sellerName}? Ela volta a responder a partir da PRÓXIMA mensagem da cliente — quem já recebeu "a equipe vai responder" não é avisada de novo.`,
      )
    ) {
      return;
    }
    runAction(returnConversationToBotAction);
  };

  const closeConversation = () => {
    if (
      !window.confirm(
        "Encerrar esta conversa? Ninguém mais responde por aqui; se a cliente escrever de novo, abre uma conversa nova (o caderninho vai junto).",
      )
    ) {
      return;
    }
    setError(null);
    setMenuOpen(false);
    startTransition(async () => {
      const problem = await onClose(conversationId);
      if (problem) setError(problem);
    });
  };

  return (
    <div className="shrink-0">
      <header className="flex items-center gap-2 border-b border-ivory-300 bg-ivory-50 px-2 py-2 md:px-4 dark:border-ink-800 dark:bg-ink-950">
        <button
          type="button"
          onClick={onBack}
          aria-label="Voltar para a lista de conversas"
          className={cx(iconButton, "md:hidden")}
        >
          <BackIcon />
        </button>
        <span
          aria-hidden="true"
          className={cx(
            "grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold ring-2 ring-offset-2 ring-offset-ivory-50 dark:ring-offset-ink-950",
            isOwnerNotices ? "bg-ink-900 text-gold-300" : "bg-ivory-300 text-ink-900",
            badge.tone === "success"
              ? "ring-gold-500"
              : badge.tone === "warning"
                ? "ring-amber-500"
                : badge.tone === "danger"
                  ? "ring-red-400"
                  : "ring-zinc-300 dark:ring-ink-700",
          )}
        >
          {isOwnerNotices ? "★" : initialsFor(customerName ?? displayName, phoneE164)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-900 dark:text-ivory-100">
            {name}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-ink-300">
            <span className="md:hidden">
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </span>
            {subtitle ? (
              <span className="hidden min-w-0 truncate sm:inline">{subtitle}</span>
            ) : null}
          </p>
        </div>
        <span className="hidden md:inline-flex">
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </span>
        {status === "human" ? (
          <button
            type="button"
            onClick={returnToSeller}
            disabled={isPending || !botEnabled}
            title={!botEnabled ? `A ${sellerName} está desligada na Central` : undefined}
            className="hidden whitespace-nowrap rounded-md border border-ivory-300 px-2.5 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ivory-200 disabled:opacity-50 motion-reduce:transition-none md:inline-flex dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800"
          >
            {isPending ? "Devolvendo…" : `Devolver à ${sellerName}`}
          </button>
        ) : null}
        {status === "open" ? (
          <button
            type="button"
            onClick={() => runAction(takeOverConversationAction)}
            disabled={isPending}
            className="hidden whitespace-nowrap rounded-md bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-ivory-50 transition-colors hover:bg-ink-800 disabled:opacity-50 motion-reduce:transition-none md:inline-flex dark:bg-ivory-100 dark:text-ink-900 dark:hover:bg-ivory-200"
          >
            {isPending ? "Assumindo…" : "Assumir"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleContext}
          aria-label="Informações da cliente"
          aria-pressed={contextOpen}
          className={cx(iconButton, "xl:hidden", contextOpen && "bg-ivory-200 text-ink-900 dark:bg-ink-800")}
        >
          <InfoIcon />
        </button>
        <NotifyPrefsPopover />
        {status !== "closed" ? (
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Mais ações"
              aria-expanded={menuOpen}
              className={iconButton}
            >
              <MoreIcon />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-9 z-10 flex w-56 flex-col rounded-lg border border-ivory-300 bg-white p-1 text-sm shadow-lg dark:border-ink-700 dark:bg-ink-900"
              >
                {status === "human" ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={returnToSeller}
                    disabled={isPending || !botEnabled}
                    className="rounded-md px-3 py-2 text-left text-ink-700 hover:bg-ivory-100 disabled:opacity-50 md:hidden dark:text-ink-300 dark:hover:bg-ink-800"
                  >
                    Devolver à {sellerName}
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runAction(takeOverConversationAction)}
                    disabled={isPending}
                    className="rounded-md px-3 py-2 text-left text-ink-700 hover:bg-ivory-100 disabled:opacity-50 md:hidden dark:text-ink-300 dark:hover:bg-ink-800"
                  >
                    Assumir a conversa
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={closeConversation}
                  disabled={isPending}
                  className="rounded-md px-3 py-2 text-left text-claret-600 hover:bg-claret-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  Encerrar conversa
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
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
