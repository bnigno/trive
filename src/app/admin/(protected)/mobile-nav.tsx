"use client";

// Navegação do admin no celular: barra superior com o botão de menu e uma
// gaveta lateral com a mesma navegação do desktop. A gaveta fecha ao navegar
// (o pathname muda) e com Escape; o corpo não rola enquanto ela está aberta.
import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { AdminBrand } from "./admin-brand";
import { resolveNavTitle } from "./nav";

export function MobileNav({
  storeName,
  children,
}: {
  storeName: string;
  /** A navegação (AdminNav) e o rodapé de usuário, iguais ao desktop. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Fecha ao navegar sem setState em efeito: a gaveta só existe para o
  // pathname em que foi aberta (a chave a remonta fechada na página nova).
  const drawerKey = pathname;
  const title = resolveNavTitle(pathname);

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
      {/* h-14 (3.5rem) é medida das telas de chat: elas descontam a barra da
          altura da janela. Mudou aqui, mude lá (conversas e e-mails). */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 bg-noir-950 px-2 text-white md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Abrir o menu do painel"
          aria-expanded={open}
          className="grid size-10 place-items-center rounded-md text-zinc-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/60"
        >
          <Menu aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
        </button>
        <AdminBrand storeName={storeName} compact />
        <span className="ml-auto min-w-0 truncate pr-2 text-sm text-zinc-400">
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
            className="absolute inset-0 bg-noir-950/60 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-noir-950 text-zinc-400 shadow-2xl transition-transform duration-200 ease-out starting:-translate-x-full motion-reduce:transition-none">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <AdminBrand storeName={storeName} />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar o menu"
                className="grid size-10 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/60"
              >
                <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
              </button>
            </div>
            {children}
          </aside>
        </div>
      ) : null}
    </>
  );
}
