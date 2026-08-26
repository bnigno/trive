"use client";

import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/form";
import { normalizeAxisValue } from "@/core/catalog/attributes";

/**
 * Campo de fichas: o dono digita "Verde", aperta Enter, vira uma ficha. Não
 * usa <Field> porque o botão de remover de cada ficha ficaria dentro de um
 * <label> — clicar nele mandaria o foco para o input em vez de remover.
 */
export function ChipsField({
  label,
  hint,
  placeholder,
  values,
  onChange,
  suggestions = [],
  suggestionsLabel,
  maxValues,
}: {
  label: string;
  hint: string;
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[];
  suggestionsLabel?: string;
  maxValues: number;
}) {
  const [draft, setDraft] = useState("");
  const full = values.length >= maxValues;

  function add(candidates: string[]) {
    const next = [...values];
    for (const candidate of candidates) {
      const value = normalizeAxisValue(candidate);
      if (!value || next.length >= maxValues || next.includes(value)) continue;
      next.push(value);
    }
    if (next.length !== values.length) onChange(next);
  }

  function remove(value: string) {
    onChange(values.filter((current) => current !== value));
  }

  // A vírgula é tratada aqui, e não no teclado, para que colar uma lista
  // inteira ("verde, preto, azul") também vire fichas.
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const text = event.target.value;
    if (!text.includes(",")) {
      setDraft(text);
      return;
    }
    const parts = text.split(",");
    const tail = parts.pop() ?? "";
    add(parts);
    setDraft(tail);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Sem isto, Enter enviaria o formulário inteiro.
      event.preventDefault();
      add([draft]);
      setDraft("");
      return;
    }
    if (event.key === "Backspace" && draft === "" && values.length > 0) {
      remove(values[values.length - 1]);
    }
  }

  const remaining = suggestions.filter(
    (suggestion) => !values.includes(normalizeAxisValue(suggestion)),
  );

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </span>

      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-300 bg-white p-1.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-1 pl-3 pr-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            {value}
            <button
              type="button"
              onClick={() => remove(value)}
              aria-label={`Remover ${value}`}
              className="flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            add([draft]);
            setDraft("");
          }}
          disabled={full}
          placeholder={values.length === 0 ? placeholder : ""}
          className="min-w-32 flex-1 bg-transparent px-2 py-1 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
      </div>

      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {full ? `Você já cadastrou ${maxValues} — o limite desta tela.` : hint}
      </span>

      {remaining.length > 0 && !full ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {suggestionsLabel ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {suggestionsLabel}
            </span>
          ) : null}
          {remaining.map((suggestion) => (
            <Button
              key={suggestion}
              variant="outline"
              size="sm"
              onClick={() => add([suggestion])}
            >
              + {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
