"use client";
// Lista de espera da estreia: a cliente deixa o WhatsApp e recebe UMA mensagem
// quando a cortina abrir. Consentimento explícito, nunca pré-marcado; honeypot.
import { useState, useTransition } from "react";

import { btnGold, inputBase } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";

import { joinDropWaitlistAction } from "@/app/(store)/estreia/actions";

export function WaitlistForm({ dropId, sellerName }: { dropId: string; sellerName: string }) {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "done"; created: boolean } | { kind: "error"; message: string }>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  if (status.kind === "done") {
    return (
      <p className="rounded-(--radius-hair) border border-gold-500/40 bg-gold-400/10 px-4 py-3 font-store text-sm text-gold-200" role="status">
        {status.created
          ? `Combinado: quando a cortina abrir, a ${sellerName} te manda uma mensagem — só uma.`
          : "Você já está na lista desta estreia. Avisamos na hora."}
      </p>
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await joinDropWaitlistAction({ dropId, phone, consent, website: String(form.get("website") ?? "") });
          setStatus(result.ok ? { kind: "done", created: result.created } : { kind: "error", message: result.message });
        });
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="(91) 99999-9999"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
          aria-label="Seu WhatsApp"
          className={cx(inputBase, "flex-1 border-gold-500/40 text-ivory-50 placeholder:text-ivory-200/50 focus:border-gold-300")}
        />
        <button type="submit" disabled={pending || !consent} className={cx(btnGold, "min-h-11 px-6 disabled:cursor-not-allowed disabled:opacity-60")}>
          {pending ? "Registrando…" : "Me avisa quando abrir"}
        </button>
      </div>
      <label className="flex cursor-pointer items-start gap-2 font-store text-xs text-ivory-200/85">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-gold-400" />
        <span>Quero receber UMA mensagem no WhatsApp quando a estreia abrir. Nada além disso; para sair, basta responder SAIR.</span>
      </label>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
      {status.kind === "error" ? (
        <p className="font-store text-xs text-rose-300" role="alert">
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
