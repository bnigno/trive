"use client";

// Ícone da sacola com contador, para o header da loja. O contador só aparece
// após a hidratação (o carrinho começa vazio no primeiro render — sem mismatch).

import Link from "next/link";

import { useCart } from "./cart-context";

export function CartButton({ className }: { className?: string }) {
  const { count } = useCart();

  return (
    <Link
      href="/carrinho"
      aria-label={
        count > 0
          ? `Sacola de compras, ${count} ${count === 1 ? "item" : "itens"}`
          : "Sacola de compras, vazia"
      }
      className={[
        "relative inline-flex h-10 w-10 items-center justify-center rounded-full text-zinc-700 transition-colors hover:bg-amber-700/10 hover:text-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 dark:text-zinc-300 dark:hover:bg-amber-500/10 dark:hover:text-amber-400",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      {/* Sacola de compras (inline, sem dependência externa) */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-6 w-6"
      >
        <path d="M6 8h12l1 12a1.6 1.6 0 0 1-1.6 1.7H6.6A1.6 1.6 0 0 1 5 20L6 8Z" />
        <path d="M9 10V6a3 3 0 0 1 6 0v4" />
      </svg>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-700 px-1 text-[11px] font-semibold text-white"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
