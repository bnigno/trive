"use client";

/** Abre o diálogo de impressão do navegador; some do papel (print:hidden). */
export function PrintButton({ label = "Imprimir" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 print:hidden dark:bg-zinc-100 dark:text-zinc-900"
    >
      {label}
    </button>
  );
}
