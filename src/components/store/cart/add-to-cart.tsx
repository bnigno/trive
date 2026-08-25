"use client";

// Botão "Adicionar à sacola" com feedback imediato ("Adicionado ✓" por 2s).
// Desabilitado quando o item está esgotado (availableQty <= 0) ou quando a
// página do produto pedir (ex.: variante ainda não selecionada).

import { useEffect, useRef, useState } from "react";

import { useCart, type CartItemInput } from "./cart-context";

export function AddToCartButton({
  item,
  quantity = 1,
  disabled = false,
}: {
  item: CartItemInput;
  quantity?: number;
  disabled?: boolean;
}) {
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const soldOut = item.availableQty <= 0;
  const isDisabled = disabled || soldOut;

  function handleClick() {
    if (isDisabled) return;
    addItem(item, quantity);
    setAdded(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setAdded(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      className={[
        "inline-flex w-full items-center justify-center gap-2 rounded-full px-6 py-3.5 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 sm:w-auto sm:min-w-56",
        added
          ? "bg-emerald-700 text-white"
          : "bg-amber-700 text-white hover:bg-amber-800 active:bg-amber-900",
        "disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500",
      ].join(" ")}
    >
      {added ? (
        <span role="status">Adicionado ✓</span>
      ) : soldOut ? (
        "Esgotado"
      ) : (
        "Adicionar à sacola"
      )}
    </button>
  );
}
