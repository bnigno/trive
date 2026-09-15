"use client";

import { useEffect, useState } from "react";

export type PrintSide = "front" | "back" | "both";

/**
 * Imprime só as frentes, só os versos ou os dois lados intercalados (para
 * impressora com duplex automático). Marca `data-print-side` no <html> — o
 * CSS de impressão esconde o outro lado — e limpa quando o diálogo fecha.
 * Espera imagens e fontes como o PrintButton. Some do papel (print:hidden).
 */
export function PrintSideButtons({ sheets, bothLabel = "Frente e verso numa passada (só papel comum)" }: { sheets: number; bothLabel?: string }) {
  const [waiting, setWaiting] = useState<PrintSide | null>(null);

  useEffect(() => {
    const clear = () => document.documentElement.removeAttribute("data-print-side");
    window.addEventListener("afterprint", clear);
    return () => {
      window.removeEventListener("afterprint", clear);
      clear();
    };
  }, []);

  async function print(side: PrintSide) {
    setWaiting(side);
    try {
      await Promise.allSettled(Array.from(document.images).map((image) => image.decode()));
      await document.fonts.ready;
    } finally {
      setWaiting(null);
    }
    if (side === "both") document.documentElement.removeAttribute("data-print-side");
    else document.documentElement.setAttribute("data-print-side", side);
    window.print();
  }

  const plural = sheets === 1 ? "folha" : "folhas";
  const primary =
    "rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900";
  return (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      <button type="button" onClick={() => void print("front")} disabled={waiting !== null} className={primary}>
        {waiting === "front" ? "Carregando…" : `1. Imprimir frentes (${sheets} ${plural})`}
      </button>
      <button type="button" onClick={() => void print("back")} disabled={waiting !== null} className={primary}>
        {waiting === "back" ? "Carregando…" : `2. Imprimir versos (${sheets} ${plural})`}
      </button>
      <button
        type="button"
        onClick={() => void print("both")}
        disabled={waiting !== null}
        className="text-sm text-zinc-600 underline underline-offset-2 hover:text-zinc-900 disabled:opacity-60 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        {waiting === "both" ? "Carregando…" : bothLabel}
      </button>
    </div>
  );
}
