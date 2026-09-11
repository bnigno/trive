"use client";

import { CARE_SYMBOL_KEYS, CARE_SYMBOLS, type CareSymbolKey } from "@/core/catalog/care";
import { Field, TextArea } from "@/components/ui/form";

/**
 * Cuidados com a peça: pictogramas (checkbox por chave, campo `care:<chave>`)
 * mais linhas livres (`careText`). A action junta tudo com formatCareNotes.
 */
export function CareFields({
  symbols,
  freeText,
}: {
  symbols: readonly CareSymbolKey[];
  freeText: readonly string[];
}) {
  return (
    <Field
      label="Cuidados"
      className="sm:col-span-2"
      hint="Marque os pictogramas que valem para a peça e escreva o que mais importa, uma linha por cuidado."
    >
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          {CARE_SYMBOL_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                name={`care:${key}`}
                defaultChecked={symbols.includes(key)}
                className="h-4 w-4 rounded border-zinc-300 text-indigo-600"
              />
              {CARE_SYMBOLS[key].label}
            </label>
          ))}
        </div>
        <TextArea
          name="careText"
          rows={2}
          defaultValue={freeText.join("\n")}
          placeholder="Ex.: Não torcer. Guardar dobrada."
        />
      </div>
    </Field>
  );
}
