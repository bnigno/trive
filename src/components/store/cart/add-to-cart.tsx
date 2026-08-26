"use client";

// Botão "Adicionar à sacola" com feedback imediato ("Adicionado" por 2s).
// Desabilitado quando o item está esgotado (availableQty <= 0) ou quando a
// página do produto pedir (ex.: variante ainda não selecionada).

import { useEffect, useRef, useState } from "react";

import { IconCheck } from "@/components/store/icons";

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
        // Variação do btnPrimary (styles.ts) para a compra: mais tracking,
        // corpo menor e py maior — o CTA mais importante da vitrine.
        "inline-flex w-full items-center justify-center gap-2 rounded-(--radius-hair) px-7 py-4 font-store text-xs font-medium uppercase tracking-[0.18em] transition duration-300 ease-silk active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600 sm:w-auto sm:min-w-56",
        added
          ? "bg-gold-600 text-ink-950"
          : "bg-ink-950 text-ivory-50 hover:bg-ink-800 hover:text-gold-300",
        "disabled:cursor-not-allowed disabled:bg-ivory-300 disabled:text-ink-400",
      ].join(" ")}
    >
      {added ? (
        <span role="status" className="inline-flex items-center gap-2">
          <IconCheck className="h-4 w-4" />
          Adicionado
        </span>
      ) : soldOut ? (
        "Esgotado"
      ) : (
        "Adicionar à sacola"
      )}
    </button>
  );
}
