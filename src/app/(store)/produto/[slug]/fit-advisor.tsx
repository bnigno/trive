"use client";
// "Vai me servir?" — a ilha da página da peça: com a cartela no navegador
// (token), na primeira vez pede busto/cintura/quadril (guardados uma vez na
// cartela), depois lê o veredito por tamanho na hora. Sem cartela, convida
// para o quiz. Nada de medida fica no localStorage: só o token, como sempre.
import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";

import { Field } from "@/components/store/field";
import { btnOutline, btnPrimary, inputBase } from "@/components/store/styles";
import { readStoredStyle, storedStyleSnapshot, subscribeStoredStyle, writeStoredStyle } from "@/lib/style-storage";

import { fitAdviceAction, forgetBodyMeasurementsAction, saveBodyMeasurementsAction, type FitAdviceResult } from "./actions";

export function FitAdvisor({ slug }: { slug: string }) {
  const storedRaw = useSyncExternalStore(subscribeStoredStyle, storedStyleSnapshot, () => "");
  const stored = storedRaw ? readStoredStyle() : null;
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<FitAdviceResult | null>(null);
  const [form, setForm] = useState({ bustCm: "", waistCm: "", hipsCm: "" });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const ask = (token: string, bodyToken?: string) => {
    setError(null);
    startTransition(async () => {
      const advice = await fitAdviceAction({ slug, token, bodyToken: bodyToken ?? null });
      setResult(advice);
    });
  };

  if (!stored) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link href="/estilo" className={btnOutline}>
          Vai me servir?
        </Link>
        <p className="font-store text-xs text-ink-500">Com a sua cartela de estilo, digo como cada tamanho fica em você.</p>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          className={btnOutline}
          onClick={() => {
            setOpen(true);
            ask(stored.token, stored.bodyToken);
          }}
        >
          Vai me servir?
        </button>
      </div>
    );
  }

  const needsBody = result?.ok && result.kind === "no_body";

  return (
    <div className="mt-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 p-4 font-store text-sm text-ink-800" aria-live="polite">
      {isPending && !result ? <p className="text-ink-500">Calculando…</p> : null}
      {result && !result.ok ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-claret-600">{result.message}</p>
          <button type="button" className="text-xs text-ink-500 underline" onClick={() => ask(stored.token, stored.bodyToken)}>
            Tentar de novo
          </button>
          <Link href="/estilo" className="text-xs text-ink-500 underline">
            Refazer a cartela
          </Link>
        </div>
      ) : null}

      {needsBody ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            startTransition(async () => {
              const saved = await saveBodyMeasurementsAction({ token: stored.token, bodyToken: stored.bodyToken ?? null, ...form });
              if (!saved.ok) {
                setError(saved.message);
                return;
              }
              // A credencial das medidas fica só neste navegador, ao lado do token da cartela.
              writeStoredStyle({ ...stored, bodyToken: saved.bodyToken });
              ask(stored.token, saved.bodyToken);
            });
          }}
        >
          <p>Me conta suas medidas, em centímetros — ficam guardadas na sua cartela, uma vez só, e você apaga quando quiser. Só este aparelho (e a vendedora, no seu WhatsApp) consegue lê-las.</p>
          <div className="grid grid-cols-3 gap-3">
            {(["bustCm", "waistCm", "hipsCm"] as const).map((key) => (
              <Field key={key} label={key === "bustCm" ? "Busto" : key === "waistCm" ? "Cintura" : "Quadril"}>
                <input
                  id={`fit-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={key === "waistCm" ? 50 : 60}
                  max={200}
                  step={1}
                  placeholder="cm"
                  value={form[key]}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                  className={inputBase}
                />
              </Field>
            ))}
          </div>
          {error ? <p className="text-claret-600">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={isPending} className={btnPrimary}>
              {isPending ? "Guardando…" : "Ver como fica"}
            </button>
            <p className="text-xs text-ink-500">Contorno em cm (fita métrica) — não a numeração da roupa. Só busto, cintura e quadril.</p>
          </div>
        </form>
      ) : null}

      {result?.ok && result.kind === "advice" ? (
        <div className="flex flex-col gap-2">
          <p className="text-ink-900">{result.text}</p>
          <ul className="flex flex-col gap-1 text-xs text-ink-600">
            {result.verdicts.map((verdict) => (
              <li key={verdict.size}>
                <span className={verdict.size === result.recommended ? "font-medium text-ink-900" : ""}>{verdict.size}</span> · {verdict.overall}
                {verdict.points.length > 0 ? ` (${verdict.points.map((point) => `${point.label} ${point.cm >= 0 ? `+${point.cm}` : point.cm} cm`).join(", ")})` : ""}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="self-start text-xs text-ink-500 underline"
            onClick={() =>
              startTransition(async () => {
                await forgetBodyMeasurementsAction({ token: stored.token, bodyToken: stored.bodyToken ?? null });
                writeStoredStyle({ ...stored, bodyToken: undefined });
                setResult(null);
                setForm({ bustCm: "", waistCm: "", hipsCm: "" });
                ask(stored.token);
              })
            }
          >
            Apagar minhas medidas
          </button>
        </div>
      ) : null}

      {result?.ok && (result.kind === "no_chart" || result.kind === "no_overlap") ? <p>{result.text}</p> : null}
    </div>
  );
}
