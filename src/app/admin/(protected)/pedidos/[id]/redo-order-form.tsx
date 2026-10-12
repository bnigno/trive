"use client";

// Refazer um pedido ainda não pago: o antigo é cancelado como "substituído"
// e nasce um pedido com número novo, com as mudanças. Estoque e cupom passam
// direto; qualquer recusa (esgotou, cupom não vale, preço mudou) não muda nada.
// Envio por onSubmit (não <form action>): o React 19 limpa o form depois de
// uma action e os selects voltariam à primeira opção com o estado intacto.
import { useActionState, useState, useTransition, type FormEvent } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button, Field, FormError, Input, Select, TextArea } from "@/components/ui/form";
import { formatCentsBRL } from "@/lib/money";
import type { RedoFormData } from "@/services/order-redo";

import { quoteRedoDeliveryAction, redoOrderAction, type FormState } from "./actions";

type LineState = { variantId: string; quantity: number };
type DeliveryOptionView = { optionKey: string; label: string; priceCents: number };

export function RedoOrderForm({ data }: { data: RedoFormData }) {
  const [state, action, pending] = useActionState(redoOrderAction, {} as FormState);
  const [, startSubmit] = useTransition();
  const [lines, setLines] = useState<LineState[]>(data.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })));
  const [addSku, setAddSku] = useState("");
  const [addQty, setAddQty] = useState(1);
  const [todayPrice, setTodayPrice] = useState(false);
  const [coupon, setCoupon] = useState<"keep" | "remove" | "code">("keep");
  const [couponCode, setCouponCode] = useState("");
  const [payment, setPayment] = useState(data.paymentMethod);
  const [gift, setGift] = useState<"keep" | "remove" | "set">("keep");
  const [recipient, setRecipient] = useState(data.gift?.recipientName ?? "");
  const [message, setMessage] = useState(data.gift?.message ?? "");
  const [delivery, setDelivery] = useState<"keep" | "option">("keep");
  const [quote, setQuote] = useState<{ forItems: string; options: DeliveryOptionView[] } | null>(null);
  const [optionKey, setOptionKey] = useState("");
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, startQuote] = useTransition();

  const hard = data.blockers.filter((blocker) => !blocker.overridable);
  const overridable = data.blockers.filter((blocker) => blocker.overridable);
  if (hard.length > 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">{hard[0].message}</p>;
  }

  const siblingOf = (variantId: string) => data.lines.flatMap((line) => line.siblings).find((sibling) => sibling.variantId === variantId);
  // A MESMA peça do pedido com preço que mudou: só entra com o preço de hoje
  // se ela aceitar (a caixa). Outro tamanho ou peça nova já vem pelo preço de hoje, que aparece na lista.
  const movedPrice = (index: number) => {
    const line = data.lines[index];
    const today = siblingOf(line.variantId)?.priceCents;
    return lines[index].variantId === line.variantId && today !== undefined && today !== line.unitPriceCents ? today : null;
  };
  const pieces = [
    ...lines.filter((line) => line.quantity > 0).map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
    ...(addSku.trim() ? [{ sku: addSku.trim(), quantity: addQty }] : []),
  ];
  const items = [
    ...lines.flatMap((line, index) => {
      if (line.quantity <= 0) return [];
      const today = movedPrice(index);
      return [{ variantId: line.variantId, quantity: line.quantity, ...(todayPrice && today !== null ? { expectedUnitPriceCents: today } : {}) }];
    }),
    ...(addSku.trim() ? [{ sku: addSku.trim(), quantity: addQty }] : []),
  ];
  // A cotação vale para as peças com que foi feita (o peso): mudou a peça, cota de novo.
  const piecesJson = JSON.stringify(pieces);
  const options = quote && quote.forItems === piecesJson ? quote.options : null;
  const changes = {
    items,
    ...(coupon === "remove" ? { coupon: { kind: "remove" } } : coupon === "code" && couponCode.trim() ? { coupon: { kind: "code", code: couponCode.trim() } } : {}),
    ...(payment !== data.paymentMethod ? { paymentMethod: payment } : {}),
    ...(gift === "remove" ? { gift: { kind: "remove" } } : gift === "set" ? { gift: { kind: "set", recipientName: recipient.trim(), message: message.trim() || null } } : {}),
    ...(delivery === "option" && options && optionKey ? { delivery: { kind: "option", optionKey } } : {}),
  };
  const priceChanged = data.lines.some((_, index) => lines[index].quantity > 0 && movedPrice(index) !== null);

  function requestQuote() {
    setQuoteError(null);
    startQuote(async () => {
      const result = await quoteRedoDeliveryAction(data.orderId, piecesJson);
      if ("error" in result) {
        setQuote(null);
        setQuoteError(result.error);
        return;
      }
      setQuote({ forItems: piecesJson, options: result.options });
      setOptionKey(result.options[0]?.optionKey ?? "");
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startSubmit(() => action(formData));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <input type="hidden" name="orderId" value={data.orderId} />
      <input type="hidden" name="changes" value={JSON.stringify(changes)} />
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Para mudar o pedido antes do pagamento: o #{data.orderNumber} é cancelado como “substituído” e nasce um pedido com número novo. A cliente recebe “seu pedido foi atualizado” com o link novo — nunca “cancelado”.
      </p>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Peças</legend>
        {data.lines.map((line, index) => (
          <div key={line.variantId} className="flex flex-col gap-1">
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <Field label={line.label}>
                <Select
                  value={lines[index].variantId}
                  onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, variantId: event.target.value } : item)))}
                >
                  {line.siblings.map((sibling) => (
                    <option key={sibling.variantId} value={sibling.variantId} disabled={sibling.available === 0 && sibling.variantId !== line.variantId}>
                      {sibling.label} — {formatCentsBRL(sibling.priceCents)} · {sibling.available} {sibling.available === 1 ? "disponível" : "disponíveis"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Qtd.">
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={lines[index].quantity}
                  onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, quantity: Math.max(0, Number(event.target.value) || 0) } : item)))}
                />
              </Field>
            </div>
            {movedPrice(index) !== null ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                No pedido: {formatCentsBRL(line.unitPriceCents)} · hoje: {formatCentsBRL(movedPrice(index) ?? 0)}
              </p>
            ) : null}
          </div>
        ))}
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Field label="Acrescentar peça (SKU)" hint="Quantidade 0 numa linha acima tira a peça.">
            <Input value={addSku} onChange={(event) => setAddSku(event.target.value)} placeholder="DUNAS-PRET-M" />
          </Field>
          <Field label="Qtd.">
            <Input type="number" min={1} max={20} value={addQty} onChange={(event) => setAddQty(Math.max(1, Number(event.target.value) || 1))} />
          </Field>
        </div>
        {priceChanged ? (
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={todayPrice} onChange={(event) => setTodayPrice(event.target.checked)} />
            Cobrar o preço de hoje (só com o SIM dela)
          </label>
        ) : null}
      </fieldset>

      <Field label="Cupom" hint={data.couponCode ? `Hoje: ${data.couponCode}. Mantido, vale como na data do pedido.` : "Hoje: sem cupom."}>
        <Select value={coupon} onChange={(event) => setCoupon(event.target.value as typeof coupon)}>
          <option value="keep">{data.couponCode ? `Manter ${data.couponCode}` : "Continuar sem cupom"}</option>
          {data.couponCode ? <option value="remove">Tirar o cupom</option> : null}
          <option value="code">{data.couponCode ? "Trocar por outro" : "Aplicar um cupom"}</option>
        </Select>
      </Field>
      {coupon === "code" ? (
        <Field label="Código do cupom">
          <Input value={couponCode} onChange={(event) => setCouponCode(event.target.value)} required />
        </Field>
      ) : null}

      <Field label="Pagamento">
        <Select value={payment} onChange={(event) => setPayment(event.target.value as typeof payment)}>
          <option value="online">Pelo link (Pix ou cartão)</option>
          <option value="cash">Dinheiro na entrega</option>
        </Select>
      </Field>

      <Field label="Presente">
        <Select value={gift} onChange={(event) => setGift(event.target.value as typeof gift)}>
          <option value="keep">{data.gift ? `Manter (para ${data.gift.recipientName})` : "Não é presente"}</option>
          {data.gift ? <option value="remove">Deixar de ser presente</option> : null}
          <option value="set">{data.gift ? "Mudar o bilhete" : "Virar presente"}</option>
        </Select>
      </Field>
      {gift === "set" ? (
        <>
          <Field label="Para quem">
            <Input value={recipient} onChange={(event) => setRecipient(event.target.value)} maxLength={80} required />
          </Field>
          <Field label="Bilhete (opcional)">
            <TextArea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} maxLength={280} />
          </Field>
        </>
      ) : null}

      <Field label="Entrega" hint="Mantida, vale a mesma janela e o mesmo frete. Peças com outro peso pedem cotar de novo.">
        <Select value={delivery} onChange={(event) => setDelivery(event.target.value as typeof delivery)}>
          <option value="keep">Manter: {data.keptDeliveryLabel}</option>
          <option value="option">Escolher outra</option>
        </Select>
      </Field>
      {delivery === "option" ? (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" size="sm" onClick={requestQuote} disabled={quoting}>
            {quoting ? "Cotando…" : quote && !options ? "As peças mudaram — cotar de novo" : "Cotar entrega com estas peças"}
          </Button>
          {quoteError ? <p className="text-sm text-red-700 dark:text-red-300">{quoteError}</p> : null}
          {options && options.length === 0 ? <p className="text-sm text-zinc-600 dark:text-zinc-400">Nenhuma opção de entrega para este endereço agora.</p> : null}
          {options && options.length > 0 ? (
            <Select value={optionKey} onChange={(event) => setOptionKey(event.target.value)}>
              {options.map((option) => (
                <option key={option.optionKey} value={option.optionKey}>
                  {option.label} — {formatCentsBRL(option.priceCents)}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      ) : null}

      {overridable.length > 0 ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <input type="checkbox" name="allowPaymentAttempt" className="mt-1" />
          <span>
            {overridable.map((blocker) => blocker.message).join(" ")} Marque só depois de conferir que nada foi pago.
          </span>
        </label>
      ) : null}

      <ConfirmButton
        variant="primary"
        disabled={pending || (delivery === "option" && !(options && optionKey))}
        confirmMessage={`Refazer o pedido #${data.orderNumber}? Ele é cancelado como “substituído” e a cliente recebe o link do pedido novo.`}
      >
        {pending ? "Refazendo…" : "Refazer pedido"}
      </ConfirmButton>
      <FormError message={state.error} />
    </form>
  );
}
