"use client";

// Código de rastreio copiável com um toque. Sem serviço externo — apenas o
// código, que o cliente cola no site da transportadora/Correios.
import { useState } from "react";

import { IconCheck } from "@/components/store/icons";

// Variante compacta do btnOutline (styles.ts) com hover preenchido em dourado
// — declarada aqui para não conflitar com o padding/hover da receita original.
const copyButton =
  "inline-flex items-center justify-center gap-2 rounded-(--radius-hair) border border-ink-900/80 px-5 py-2.5 font-store text-xs font-medium uppercase tracking-[0.16em] text-ink-900 transition-colors duration-300 ease-silk hover:border-gold-600 hover:bg-gold-600 hover:text-ivory-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

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
      <code className="select-all rounded-(--radius-soft) bg-ivory-200 px-3 py-2 font-mono text-base tracking-wide text-ink-900">
        {code}
      </code>
      <button type="button" onClick={copy} className={copyButton}>
        {copied ? (
          <>
            <IconCheck className="h-4 w-4" />
            Copiado
          </>
        ) : (
          "Copiar código"
        )}
      </button>
    </div>
  );
}
