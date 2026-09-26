"use client";

// Bloco "Vídeo da peça": o botão que pede o vídeo (com o custo ao lado), as
// ações de cada vídeo, a legenda pronta com o aviso de IA e a atualização
// sozinha enquanto a FASHN trabalha. Sem regra aqui: custo e decisões vêm do
// core e do service.
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button, FormError, FormSuccess, TextArea } from "@/components/ui/form";

import { discardStudioVideoAction, refetchStudioVideoAction, requestStudioVideoAction, type FormState } from "./actions";

const INITIAL_STATE: FormState = {};
const REFRESH_MS = 20_000;

export function MakeVideoButton({
  candidateId,
  productId,
  costLabel,
  pending,
}: {
  candidateId: string;
  productId: string;
  /** "R$ 2,48": a conta é do servidor. */
  costLabel: string;
  /** Esta foto já está virando vídeo. */
  pending: boolean;
}) {
  const [state, request, submitting] = useActionState<FormState, FormData>(requestStudioVideoAction, INITIAL_STATE);
  return (
    <form action={request} className="flex flex-col gap-1">
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="productId" value={productId} />
      <ConfirmButton
        size="sm"
        variant="outline"
        disabled={submitting || pending}
        confirmMessage={`Fazer um vídeo de 5 s desta foto? Custa ≈ ${costLabel} (6 créditos da FASHN) e fica pronto em uns 5 minutos.`}
      >
        {pending ? "Fazendo o vídeo…" : submitting ? "Colocando na fila…" : `Fazer vídeo (≈ ${costLabel})`}
      </ConfirmButton>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}

export function VideoActions({
  videoId,
  productId,
  canRefetch,
  canDiscard,
}: {
  videoId: string;
  productId: string;
  canRefetch: boolean;
  canDiscard: boolean;
}) {
  const [refetchState, refetch, refetching] = useActionState<FormState, FormData>(refetchStudioVideoAction, INITIAL_STATE);
  const [discardState, discard, discarding] = useActionState<FormState, FormData>(discardStudioVideoAction, INITIAL_STATE);
  if (!canRefetch && !canDiscard) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {canRefetch ? (
          <form action={refetch}>
            <input type="hidden" name="videoId" value={videoId} />
            <input type="hidden" name="productId" value={productId} />
            <Button type="submit" size="sm" disabled={refetching || discarding}>
              {refetching ? "Buscando…" : "Buscar de novo (sem pagar)"}
            </Button>
          </form>
        ) : null}
        {canDiscard ? (
          <form action={discard}>
            <input type="hidden" name="videoId" value={videoId} />
            <input type="hidden" name="productId" value={productId} />
            <ConfirmButton
              size="sm"
              variant="outline"
              disabled={refetching || discarding}
              confirmMessage="Descartar este vídeo? Ele some da lista e o arquivo é apagado (o custo fica no histórico)."
            >
              {discarding ? "Descartando…" : "Descartar"}
            </ConfirmButton>
          </form>
        ) : null}
      </div>
      <FormError message={refetchState.error ?? discardState.error} />
      <FormSuccess message={refetchState.success ?? discardState.success} />
    </div>
  );
}

/** A legenda para colar no Instagram: sempre legível (copiar à mão funciona) e com o botão de copiar. */
export function VideoCaption({ caption, notice }: { caption: string | null; notice: string }) {
  const text = caption ?? notice;
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ tone: "ok", text: "Legenda copiada." });
    } catch {
      setMessage({ tone: "error", text: "Não consegui copiar. Selecione o texto da legenda e copie à mão." });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <TextArea readOnly rows={caption ? 6 : 2} value={text} aria-label="Legenda do vídeo" className="text-xs" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={handleCopy}>
          Copiar legenda
        </Button>
        {message ? (
          <span className={message.tone === "ok" ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-red-700 dark:text-red-400"}>
            {message.text}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {caption
          ? "No Instagram, ligue também o rótulo de IA (“Informações de IA”) ao publicar."
          : "A legenda completa sai quando a peça tiver preço, foto e estiver na vitrine; o aviso de IA vai sempre. No Instagram, ligue também o rótulo de IA."}
      </p>
    </div>
  );
}

/**
 * Enquanto um vídeo é feito (`active`), a tela se atualiza sozinha a cada
 * 20 s (parada com a aba escondida). Sempre embrulha o bloco — ligado ou não
 * — para o React não remontar os formulários (e perder a mensagem) quando o
 * vídeo termina.
 */
export function VideoAutoRefresh({ active, children }: { active: boolean; children: React.ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      router.refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return (
    <div className="flex flex-col gap-2">
      {children}
      {active ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400" aria-live="polite">
          A tela atualiza sozinha enquanto o vídeo é feito.
        </p>
      ) : null}
    </div>
  );
}
