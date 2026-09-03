"use client";

// Botão "Adicionar à sacola" com feedback imediato ("Adicionado" por 2s).
// Desabilitado quando o item está esgotado (availableQty <= 0) ou quando a
// página do produto pedir (ex.: variante ainda não selecionada).

import { useEffect, useRef, useState } from "react";

import { useCart, type CartItemInput } from "./cart-context";

/** O check do Laço: a curva se desenha (ribbon-check) ao confirmar a compra. */
function RibbonCheck() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path
        d="M4.5 12.5c3 1.6 5 3.6 6.2 5.5C12.5 12.8 15.6 9 20 5.5"
        pathLength={1}
        style={{ strokeDasharray: 1 }}
        className="animate-ribbon-check"
      />
    </svg>
  );
}

export function AddToCartButton({
  item,
  quantity = 1,
  disabled = false,
  compact = false,
}: {
  item: CartItemInput;
  quantity?: number;
  disabled?: boolean;
  /** Versão curta para a barra fixa de compra do celular. */
  compact?: boolean;
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
        "press-sheen inline-flex items-center justify-center gap-2 rounded-(--radius-hair) font-store text-xs font-medium uppercase tracking-[0.18em] transition duration-300 ease-silk active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
        compact
          ? "min-h-12 shrink-0 px-5 py-3"
          : "min-h-13 w-full px-7 py-4 sm:w-auto sm:min-w-56",
        added
          ? "bg-gold-600 text-ink-950"
          : "bg-ink-950 text-ivory-50 hover:bg-ink-800 hover:text-gold-300",
        "disabled:cursor-not-allowed disabled:bg-ivory-300 disabled:text-ink-400",
      ].join(" ")}
    >
      {added ? (
        <span role="status" className="inline-flex items-center gap-2">
          <RibbonCheck />
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
