"use client";

import { useCallback, useRef, useState, type RefObject } from "react";

import type { CepAddress } from "@/adapters/cep";

export type CepAutofillStatus = "idle" | "loading" | "filled" | "not_found" | "error";

type LookupResult =
  | { ok: true; address: CepAddress }
  | { ok: false; reason: "cep_invalido" | "nao_encontrado" | "indisponivel" };

/**
 * Preenche rua, bairro, cidade e UF quando o CEP completa 8 dígitos, e leva o
 * cursor para o número. Só escreve em campo vazio — ou em todos, quando o CEP
 * mudou depois do último preenchimento (a cliente corrigiu o CEP). Nunca
 * bloqueia o envio: sem resposta, ela digita à mão como antes.
 */
export function useCepAutofill(
  formRef: RefObject<HTMLFormElement | null>,
  lookup: (cep: string) => Promise<LookupResult>,
  names: { street: string; district: string; city: string; state: string; focus: string } = {
    street: "street",
    district: "district",
    city: "city",
    state: "state",
    focus: "number",
  },
): { status: CepAutofillStatus; onCepChange: (value: string) => void } {
  const [status, setStatus] = useState<CepAutofillStatus>("idle");
  const lastLookedUp = useRef<string | null>(null);
  const lastFilled = useRef<string | null>(null);

  const onCepChange = useCallback(
    (value: string) => {
      const digits = value.replace(/\D/g, "");
      if (digits.length !== 8) {
        if (status !== "idle") setStatus("idle");
        return;
      }
      if (lastLookedUp.current === digits) return;
      lastLookedUp.current = digits;
      setStatus("loading");
      void lookup(digits).then((result) => {
        // Resposta atrasada de um CEP anterior: ignora.
        if (lastLookedUp.current !== digits) return;
        const form = formRef.current;
        if (!result.ok || !form) {
          setStatus(!result.ok && result.reason === "nao_encontrado" ? "not_found" : "error");
          return;
        }
        const overwrite = lastFilled.current !== null && lastFilled.current !== digits;
        const fill = (name: string, next: string) => {
          const element = form.elements.namedItem(name);
          if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement)) return;
          if (next === "") return;
          if (element.value.trim() === "" || overwrite) element.value = next;
        };
        fill(names.street, result.address.street);
        fill(names.district, result.address.district);
        fill(names.city, result.address.city);
        fill(names.state, result.address.state);
        lastFilled.current = digits;
        setStatus("filled");
        const focus = form.elements.namedItem(names.focus);
        if (focus instanceof HTMLInputElement) focus.focus();
      });
    },
    [formRef, lookup, names, status],
  );

  return { status, onCepChange };
}

export const CEP_AUTOFILL_MESSAGES: Record<Exclude<CepAutofillStatus, "idle">, string> = {
  loading: "Buscando endereço…",
  filled: "Endereço preenchido — confira e informe o número.",
  not_found: "CEP não encontrado — preencha o endereço à mão.",
  error: "Não deu para buscar o endereço agora — preencha à mão.",
};
