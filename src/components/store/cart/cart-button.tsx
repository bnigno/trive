"use client";

// Ícone da sacola com contador, para o header da loja. O contador só aparece
// após a hidratação (o carrinho começa vazio no primeiro render — sem mismatch).

import Link from "next/link";

import { IconBag } from "@/components/store/icons";

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
        "relative inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-800 transition-colors duration-300 hover:bg-ivory-200 hover:text-ink-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      <IconBag className="h-6 w-6" />
      {count > 0 ? (
        // key={count} remonta o badge a cada mudança e re-dispara o cart-bump.
        <span
          key={count}
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 animate-cart-bump items-center justify-center rounded-full bg-ink-950 px-1 font-store text-[11px] font-medium text-ivory-50"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
