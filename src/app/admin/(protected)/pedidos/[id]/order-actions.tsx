"use client";

import { useActionState } from "react";

import type { OrderStatus } from "@/core/orders/state-machine";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import {
  cancelOrderAction,
  confirmOrderAction,
  markDeliveredAction,
  markPaidAction,
  markShippedAction,
  refundOrderAction,
  startPreparingAction,
  type FormState,
} from "./actions";

const initialState: FormState = {};

type ActionFn = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Form simples de avanço de status: um botão primary + mensagem de resultado. */
function AdvanceForm({
  orderId,
  action,
  label,
  pendingLabel,
  hint,
  confirmMessage,
}: {
  orderId: string;
  action: ActionFn;
  label: string;
  pendingLabel: string;
  hint?: string;
  /** Pede confirmação antes de enviar (ações com efeito imediato no cliente). */
  confirmMessage?: string;
}) {
  const [state, formAction] = useActionState(action, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      {confirmMessage ? (
        <ConfirmButton variant="primary" confirmMessage={confirmMessage}>
          {label}
        </ConfirmButton>
      ) : (
        <SubmitButton pendingLabel={pendingLabel}>{label}</SubmitButton>
      )}
      {hint ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </form>
  );
}

function ShipForm({
  orderId,
  currentTrackingCode,
}: {
  orderId: string;
  currentTrackingCode: string | null;
}) {
  const [state, formAction] = useActionState(markShippedAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <Field
        label="Código de rastreio"
        hint="Opcional — deixe em branco se a entrega não tiver rastreio."
      >
        <Input
          name="trackingCode"
          defaultValue={currentTrackingCode ?? ""}
          placeholder="Ex.: AA123456789BR"
          maxLength={100}
        />
      </Field>
      <SubmitButton pendingLabel="Marcando…">Marcar como enviado</SubmitButton>
    </form>
  );
}

function CancelLikeForm({
  orderId,
  action,
  reasonRequired,
  showRestock,
  label,
  confirmMessage,
  hint,
}: {
  orderId: string;
  action: ActionFn;
  reasonRequired: boolean;
  showRestock: boolean;
  label: string;
  confirmMessage: string;
  hint?: string;
}) {
  const [state, formAction] = useActionState(action, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <Field
        label={reasonRequired ? "Motivo (obrigatório)" : "Motivo (opcional)"}
        hint="Fica registrado no histórico do pedido."
      >
        <TextArea
          name="reason"
          required={reasonRequired}
          maxLength={2000}
          placeholder="Ex.: cliente desistiu da compra"
          className="min-h-16"
        />
      </Field>
      {showRestock ? (
        <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            name="restock"
            className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-indigo-600 dark:border-zinc-700"
          />
          <span>
            Devolver itens ao estoque
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
              Marque somente se a mercadoria voltou fisicamente para você.
            </span>
          </span>
        </label>
      ) : null}
      <div>
        <ConfirmButton confirmMessage={confirmMessage}>{label}</ConfirmButton>
      </div>
      {hint ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </form>
  );
}

function Divider() {
  return <hr className="border-zinc-200 dark:border-zinc-800" />;
}

export function OrderActions({
  orderId,
  status,
  paymentMethod,
  trackingCode,
  canRefund,
}: {
  orderId: string;
  status: OrderStatus;
  paymentMethod: string | null;
  trackingCode: string | null;
  /** Reembolso lança saída no financeiro: só o dono. A action confere de novo. */
  canRefund: boolean;
}) {
  if (status === "canceled" || status === "refunded") {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Este pedido está encerrado — nenhuma ação disponível.
      </p>
    );
  }

  // Cancelamento vindo de status pós-pagamento exige motivo e permite restock.
  const postConsumption =
    status === "paid" ||
    status === "preparing" ||
    status === "shipped" ||
    status === "delivered";

  return (
    <div className="flex flex-col gap-4">
      {status === "draft" ? (
        <AdvanceForm
          orderId={orderId}
          action={confirmOrderAction}
          label="Confirmar pedido"
          pendingLabel="Confirmando…"
          hint="Ao confirmar, o estoque dos itens fica reservado enquanto você aguarda o pagamento."
        />
      ) : null}

      {status === "pending_payment" ? (
        <AdvanceForm
          orderId={orderId}
          action={markPaidAction}
          label="Marcar como pago"
          pendingLabel="Marcando…"
          hint={
            paymentMethod === "cash"
              ? "Pedido em dinheiro na entrega: marque como pago SOMENTE com o dinheiro na mão. Baixa o estoque em definitivo, liquida a venda no financeiro e o cliente recebe o comprovante na hora."
              : "Baixa o estoque em definitivo e lança a venda no financeiro."
          }
          confirmMessage={
            paymentMethod === "cash"
              ? "Confirme só depois de receber o dinheiro: o cliente recebe o comprovante de pagamento na hora. Marcar como pago?"
              : undefined
          }
        />
      ) : null}

      {status === "paid" ? (
        <>
          <AdvanceForm
            orderId={orderId}
            action={startPreparingAction}
            label="Iniciar separação"
            pendingLabel="Iniciando…"
          />
          <AdvanceForm
            orderId={orderId}
            action={markDeliveredAction}
            label="Marcar como entregue"
            pendingLabel="Marcando…"
            hint="Entrega direta, sem passar por separação e envio — ex.: dinheiro na entrega ou entrega em mãos."
          />
        </>
      ) : null}

      {status === "preparing" ? (
        <ShipForm orderId={orderId} currentTrackingCode={trackingCode} />
      ) : null}

      {status === "shipped" ? (
        <AdvanceForm
          orderId={orderId}
          action={markDeliveredAction}
          label="Marcar entregue"
          pendingLabel="Marcando…"
        />
      ) : null}

      {status === "draft" ||
      status === "pending_payment" ||
      status === "paid" ||
      status === "preparing" ? (
        <>
          <Divider />
          <CancelLikeForm
            orderId={orderId}
            action={cancelOrderAction}
            reasonRequired={postConsumption}
            showRestock={postConsumption}
            label="Cancelar pedido"
            confirmMessage="Tem certeza que deseja cancelar este pedido? Essa ação não pode ser desfeita."
            hint={
              status === "pending_payment"
                ? "A reserva de estoque será liberada automaticamente."
                : undefined
            }
          />
        </>
      ) : null}

      {postConsumption && canRefund ? (
        <>
          <Divider />
          <CancelLikeForm
            orderId={orderId}
            action={refundOrderAction}
            reasonRequired={false}
            showRestock
            label="Reembolsar"
            confirmMessage="Tem certeza que deseja reembolsar este pedido? Um lançamento de reembolso será criado no financeiro."
          />
        </>
      ) : null}
    </div>
  );
}
