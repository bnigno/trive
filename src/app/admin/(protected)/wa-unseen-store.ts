"use client";

// Os números do WhatsApp que o painel inteiro enxerga (crachá do menu — que
// monta na lateral E na gaveta do celular — e título da aba). Quem escreve:
// o avisador, em qualquer página; na página de conversas, o próprio chat,
// que já tem a lista fresca a cada 3 s.
import { useSyncExternalStore } from "react";

export type WaUnseenSnapshot = {
  /** Conversas transferidas para o dono com mensagem não vista. */
  awaitingOwner: number;
  /** Conversas com mensagem não vista em qualquer status aberto (inclui as de cima). */
  withNewMessages: number;
  suggestionCount: number;
};

const EMPTY: WaUnseenSnapshot = { awaitingOwner: 0, withNewMessages: 0, suggestionCount: 0 };

let snapshot: WaUnseenSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function publishWaUnseen(next: WaUnseenSnapshot): void {
  if (
    next.awaitingOwner === snapshot.awaitingOwner &&
    next.withNewMessages === snapshot.withNewMessages &&
    next.suggestionCount === snapshot.suggestionCount
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWaUnseen(): WaUnseenSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
