"use client";
// Peça esgotada: a cliente deixa o WhatsApp e recebe UMA mensagem quando
// voltar. Consentimento explícito, nunca pré-marcado; honeypot escondido.
import { useState, useTransition } from "react";

import { cx } from "@/components/ui/cx";
import { btnOutline, inputBase } from "@/components/store/styles";

import { requestStockAlertAction } from "./actions";

export function RestockAlertForm({ variantId }: { variantId: string }) {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "done"; created: boolean } | { kind: "error"; message: string }>({
    kind: "idle",
  });
  const [pending, startTransition] = useTransition();

  if (status.kind === "done") {
    return (
      <p className="mt-3 rounded-(--radius-hair) border border-laurel-700/30 bg-laurel-700/5 px-3 py-2 font-store text-sm text-laurel-700" role="status">
        {status.created
          ? "Combinado: assim que voltar, você recebe uma mensagem — só uma."
          : "Você já está na lista desta peça. Avisamos assim que voltar."}
      </p>
    );
  }

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await requestStockAlertAction({
            variantId,
            phone,
            consent,
            website: String(form.get("website") ?? ""),
          });
          setStatus(result.ok ? { kind: "done", created: result.created } : { kind: "error", message: result.message });
        });
      }}
    >
      <p className="font-store text-sm text-ink-700">
        Quer saber quando voltar? Deixe o seu WhatsApp e avisamos com uma única mensagem.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="(11) 99999-9999"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
          aria-label="Seu WhatsApp"
          className={cx(inputBase, "flex-1")}
        />
        <button type="submit" disabled={pending || !consent} className={cx(btnOutline, "min-h-11 px-5")}>
          {pending ? "Registrando…" : "Me avisa quando voltar"}
        </button>
      </div>
      <label className="flex cursor-pointer items-start gap-2 font-store text-xs text-ink-700">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-gold-600"
        />
        <span>Quero receber UMA mensagem no WhatsApp quando esta peça voltar. Nada além disso.</span>
      </label>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
      {status.kind === "error" ? (
        <p className="font-store text-xs text-claret-600" role="alert">
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
