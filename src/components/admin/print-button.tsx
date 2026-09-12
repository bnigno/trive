"use client";

import { useState } from "react";

/**
 * Abre o diálogo de impressão do navegador depois que TODAS as imagens da
 * página carregaram (uma imagem recém-gerada ainda chegando sairia em
 * branco). Some do papel (print:hidden).
 */
export function PrintButton({ label = "Imprimir" }: { label?: string }) {
  const [waiting, setWaiting] = useState(false);
  async function print() {
    setWaiting(true);
    try {
      await Promise.allSettled(Array.from(document.images).map((image) => image.decode()));
    } finally {
      setWaiting(false);
    }
    window.print();
  }
  return (
    <button
      type="button"
      onClick={() => void print()}
      disabled={waiting}
      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60 print:hidden dark:bg-zinc-100 dark:text-zinc-900"
    >
      {waiting ? "Carregando…" : label}
    </button>
  );
}
