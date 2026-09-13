"use client";

// "Pague até 13h e chega hoje, 19h–21h": o selo do motoboy na página da
// peça, só para quem já digitou o CEP na sacola (guardado no navegador).
// Sem CEP, sem motoboy para o CEP ou servidor fora: não mostra nada — é
// promessa, não erro. A conta é do servidor (relógio de SP, hora-limite).
import { useEffect, useState, useSyncExternalStore } from "react";

import type { SameDayPromise } from "@/core/shipping/delivery-windows";
import { formatCep } from "@/lib/cep";
import { readStoredCep, subscribeStoredCep } from "@/lib/cep-storage";

function getServerSnapshot(): string | null {
  return null;
}

export function SameDayPromiseBadge({
  weightGrams,
  quote,
}: {
  weightGrams: number | null;
  quote: (input: { cep: string; weightGrams: number | null }) => Promise<SameDayPromise | null>;
}) {
  const cep = useSyncExternalStore(subscribeStoredCep, readStoredCep, getServerSnapshot);
  // Guardado junto com a chave que o gerou: CEP ou variação mudam → a
  // promessa antiga não vale mais e some até a nova chegar.
  const [state, setState] = useState<{ key: string; promise: SameDayPromise | null } | null>(null);
  const key = cep ? `${cep}|${weightGrams ?? ""}` : null;

  useEffect(() => {
    if (!key || !cep) return;
    let alive = true;
    quote({ cep, weightGrams })
      .then((result) => {
        if (alive) setState({ key, promise: result });
      })
      .catch(() => {
        if (alive) setState({ key, promise: null });
      });
    return () => {
      alive = false;
    };
  }, [key, cep, weightGrams, quote]);

  const promise = key && state?.key === key ? state.promise : null;
  if (!cep || !promise) return null;

  return (
    <p className="font-store text-sm leading-relaxed text-ink-700" role="status">
      <span aria-hidden="true">🛵 </span>
      <span className="font-medium text-ink-900">{promise.label}</span>
      <span className="text-ink-500">
        {" "}
        · {promise.rateName} para o CEP {formatCep(cep)}
      </span>
    </p>
  );
}
