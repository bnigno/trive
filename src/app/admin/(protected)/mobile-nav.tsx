"use client";

// Navegação do admin no celular: barra superior com o botão de menu e uma
// gaveta lateral com a mesma navegação do desktop. A gaveta fecha ao navegar
// (o pathname muda) e com Escape; o corpo não rola enquanto ela está aberta.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { cx } from "@/components/ui/cx";

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MobileNav({
  title,
  children,
}: {
  /** Nome curto da área atual, mostrado na barra superior. */
  title: string;
  /** A navegação (AdminNav) e o rodapé de usuário, iguais ao desktop. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Fecha ao navegar sem setState em efeito: a gaveta só existe para o
  // pathname em que foi aberta (a chave a remonta fechada na página nova).
  const drawerKey = pathname;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Abrir o menu do painel"
          aria-expanded={open}
          className="grid h-10 w-10 place-items-center rounded-md text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <MenuIcon />
        </button>
        <Link
          href="/admin"
          className="text-base font-semibold tracking-[0.2em] text-zinc-900 dark:text-zinc-100"
        >
          TRIVÉ
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400">
          {title}
        </span>
      </header>

      {open ? (
        <div
          key={drawerKey}
          className="fixed inset-0 z-50 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu do painel"
          // Tocar num link da navegação fecha a gaveta (o pathname muda em seguida).
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <button
            type="button"
            aria-label="Fechar o menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-zinc-950/40"
          />
          <aside
            className={cx(
              "absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-2xl dark:bg-zinc-900",
            )}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div>
                <p className="text-lg font-semibold tracking-[0.2em] text-zinc-900 dark:text-zinc-100">
                  TRIVÉ
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Painel administrativo
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar o menu"
                className="grid h-10 w-10 place-items-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <CloseIcon />
              </button>
            </div>
            {children}
          </aside>
        </div>
      ) : null}
    </>
  );
}
