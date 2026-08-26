"use client";

import { useEffect, useRef, useState } from "react";

import { cx } from "./cx";
import { Button } from "./form";

/**
 * Campo somente-leitura com botão "Copiar". Genérico: serve para qualquer
 * texto que a pessoa precisa levar para outro lugar (link, senha provisória,
 * chave Pix, código de rastreio).
 *
 * O valor NUNCA é editável: quem edita um link de acesso quebra o link sem
 * perceber. E o `input` continua na tela mesmo quando a área de transferência
 * não funciona (navegador antigo ou página sem https) — nesse caso o texto é
 * selecionado e a pessoa copia à mão, em vez de ficar sem saída.
 */
export function CopyField({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    const input = inputRef.current;
    input?.focus();
    input?.select();
    try {
      await navigator.clipboard.writeText(value);
      setManual(false);
      setCopied(true);
    } catch {
      setManual(true);
    }
  }

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          readOnly
          value={value}
          aria-label={label}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleCopy}
          className="shrink-0"
        >
          {copied ? "Copiado!" : "Copiar"}
        </Button>
      </div>
      {manual ? (
        <span role="status" className="text-xs text-amber-700 dark:text-amber-400">
          O navegador não deixou copiar sozinho — o texto já está selecionado,
          use Ctrl+C (ou ⌘+C).
        </span>
      ) : null}
      {hint && !manual ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copiado.` : ""}
      </span>
    </div>
  );
}
