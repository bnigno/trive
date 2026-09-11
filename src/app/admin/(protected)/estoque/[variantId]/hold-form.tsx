"use client";
import { useActionState } from "react";

import { createHoldAction, type HoldFormState } from "./hold-actions";

const initial: HoldFormState = {};

export function HoldForm({ variantId, available }: { variantId: string; available: number }) {
  const [state, action, pending] = useActionState(createHoldAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="variantId" value={variantId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-700 dark:text-zinc-300">WhatsApp da cliente</span>
          <input
            name="phone"
            type="tel"
            required
            placeholder="(11) 99999-9999"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-700 dark:text-zinc-300">Qtd.</span>
          <select name="quantity" defaultValue="1" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={pending || available <= 0}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Separando…" : "Separar para cliente"}
        </button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Segura a peça para esse número pelo prazo da reserva gentil (padrão 24 h), sem pedido. Vale uma reserva ativa por cliente.
      </p>
      {state.error ? <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{state.success}</p> : null}
    </form>
  );
}
