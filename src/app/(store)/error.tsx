"use client";

// Erro inesperado na vitrine. Next 16 entrega { error, retry } (não `reset`):
// retry() tenta renderizar de novo o segmento que falhou. Só React aqui —
// nada de src/db em arquivo client.
import Link from "next/link";
import { useEffect } from "react";

import { btnOutline, btnPrimary, eyebrow } from "@/components/store/styles";

export default function StoreError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center gap-6 px-4 py-20 text-center"
    >
      <p className={eyebrow}>Algo saiu do lugar</p>
      <h1 className="font-display text-title font-semibold text-balance text-espresso-900">
        Não foi você. Tente de novo em um instante.
      </h1>
      <p className="max-w-md text-[15px] leading-7 text-ink-700">
        Tivemos um contratempo ao montar esta página. Sua sacola continua
        guardada.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => retry()} className={btnPrimary}>
          Tentar de novo
        </button>
        <Link href="/" className={btnOutline}>
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
