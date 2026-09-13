// O CEP que a cliente já digitou na sacola, guardado no navegador para a
// página da peça prometer "pague até 13h e chega hoje" sem pedir de novo.
// Só o CEP (8 dígitos), nunca endereço. Todo acesso em try/catch: modo
// privado, cota cheia ou sandbox de preview não podem quebrar a vitrine.
const STORAGE_KEY = "trive-cep-v1";
const CHANGE_EVENT = "trive-cep-change";

export function readStoredCep(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && /^\d{8}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredCep(cepDigits: string): void {
  if (!/^\d{8}$/.test(cepDigits)) return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === cepDigits) return;
    window.localStorage.setItem(STORAGE_KEY, cepDigits);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // sem storage, sem promessa — a sacola continua funcionando
  }
}

/** Para useSyncExternalStore: avisa quando o CEP muda nesta aba ou em outra. */
export function subscribeStoredCep(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
