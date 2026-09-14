"use client";
// Aprovar / Recusar / Retirar uma foto do "Quem já vestiu". Retirar pede
// confirmação: a foto some da vitrine para sempre (a cliente fica com o cartão).
import { useActionState } from "react";

import { Button } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { approveLookAction, rejectLookAction, revokeLookAction, type LookFormState } from "./actions";

function Feedback({ state }: { state: LookFormState }) {
  if (state.error) return <span className="text-xs text-red-700 dark:text-red-300">{state.error}</span>;
  if (state.success) return <span className="text-xs text-emerald-700 dark:text-emerald-300">{state.success}</span>;
  return null;
}

export function ApproveRejectForms({ lookId, productSlug }: { lookId: string; productSlug: string }) {
  const [approveState, approve, approving] = useActionState<LookFormState, FormData>(approveLookAction, {});
  const [rejectState, reject, rejecting] = useActionState<LookFormState, FormData>(rejectLookAction, {});
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={approve}>
        <input type="hidden" name="lookId" value={lookId} />
        <input type="hidden" name="productSlug" value={productSlug} />
        <Button type="submit" size="sm" disabled={approving || rejecting}>
          {approving ? "Aprovando…" : "Aprovar"}
        </Button>
      </form>
      <form action={reject}>
        <input type="hidden" name="lookId" value={lookId} />
        <input type="hidden" name="productSlug" value={productSlug} />
        <Button type="submit" size="sm" variant="outline" disabled={approving || rejecting}>
          {rejecting ? "Recusando…" : "Recusar"}
        </Button>
      </form>
      <Feedback state={approveState} />
      <Feedback state={rejectState} />
    </div>
  );
}

export function RevokeForm({ lookId, productSlug }: { lookId: string; productSlug: string }) {
  const [state, formAction, pending] = useActionState<LookFormState, FormData>(revokeLookAction, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="lookId" value={lookId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      <ConfirmButton size="sm" variant="outline" disabled={pending} confirmMessage="Retirar esta foto da vitrine? Ela some da página da peça para sempre (a cliente continua com o cartão).">
        {pending ? "Retirando…" : "Retirar"}
      </ConfirmButton>
      <Feedback state={state} />
    </form>
  );
}
