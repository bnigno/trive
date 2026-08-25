"use client";

// Código de rastreio copiável com um toque. Sem serviço externo — apenas o
// código, que o cliente cola no site da transportadora/Correios.
import { useState } from "react";

export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Sem permissão de clipboard: o código continua selecionável ao lado.
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <code className="select-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-base tracking-wide text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
        {code}
      </code>
      <button
        type="button"
        onClick={copy}
        className="rounded-full border border-amber-700 px-4 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-700 hover:text-white dark:border-amber-600 dark:text-amber-400 dark:hover:bg-amber-600 dark:hover:text-zinc-950"
      >
        {copied ? "Copiado ✓" : "Copiar código"}
      </button>
    </div>
  );
}
