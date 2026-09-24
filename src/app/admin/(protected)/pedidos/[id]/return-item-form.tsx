"use client";

// Devolver uma peça do pedido. O valor vem calculado (o que a cliente pagou,
// já abatida a parte do cupom), mas fica editável: dinheiro de cliente é
// decisão do dono, não do rateio.
import { useActionState, useState } from "react";

import { Button, Field, Input, Select, TextArea } from "@/components/ui/form";
import { formatCentsBRL } from "@/lib/money";

import { returnOrderItemAction } from "./actions";

export type ReturnableItemOption = {
  id: string;
  label: string;
  /** Quantas unidades ainda podem voltar (já descontadas as devolvidas). */
  remaining: number;
  /** O que ela pagou por UMA unidade, em centavos. */
  unitRefundCents: number;
  /** true = o cupom valia só para algumas peças: o valor é sugestão. */
  needsReview: boolean;
};

export function ReturnItemForm({ orderId, items }: { orderId: string; items: ReturnableItemOption[] }) {
  const [state, action, pending] = useActionState(returnOrderItemAction, {} as { success?: string; error?: string });
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);

  const item = items.find((i) => i.id === itemId) ?? items[0];
  const sugerido = item ? item.unitRefundCents * quantity : 0;

  if (items.length === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Todas as peças deste pedido já voltaram.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />

      <Field label="Peça que voltou">
        <Select name="orderItemId" value={itemId} onChange={(e) => { setItemId(e.target.value); setQuantity(1); }}>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label} — {formatCentsBRL(i.unitRefundCents)} cada
            </option>
          ))}
        </Select>
      </Field>

      {item && item.remaining > 1 ? (
        <Field label={`Quantas (até ${item.remaining})`}>
          <Input name="quantity" type="number" min={1} max={item.remaining} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
        </Field>
      ) : (
        <input type="hidden" name="quantity" value={1} />
      )}

      <Field label="Valor a devolver (R$)" hint="Já está sem a parte do cupom que coube a esta peça. O frete não volta em devolução de item.">
        <Input name="refundCents" defaultValue={(sugerido / 100).toFixed(2)} key={`${itemId}-${quantity}`} inputMode="decimal" />
      </Field>

      {item?.needsReview ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          O cupom deste pedido valia só para algumas peças, e o pedido não guarda quais. Confira o valor antes de devolver.
        </p>
      ) : null}

      <Field label="Como resolver">
        <Select name="resolution" defaultValue="credito">
          <option value="credito">Crédito para a próxima compra (vira cupom dela)</option>
          <option value="dinheiro">Dinheiro de volta (estorno no Mercado Pago)</option>
        </Select>
      </Field>

      <Field label="Motivo (opcional)">
        <TextArea name="reason" rows={2} placeholder="Ficou grande, não gostou do modelo…" />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? "Registrando…" : "Registrar devolução"}
      </Button>

      {state.error ? <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{state.success}</p> : null}
    </form>
  );
}
