// O cupom guardado no navegador, em duas chaves: o que chegou pelo link
// /c/CODIGO (story, indicação) fica PENDENTE até a sacola tentar aplicar —
// consumido uma vez; o que a sacola APLICOU de verdade fica no aplicado, que
// é o que o checkout lê. Só o código. Todo acesso em try/catch: modo privado
// ou cota cheia não podem quebrar a vitrine.
const STORAGE_KEY = "trive-coupon-v1";
const LINK_KEY = "trive-coupon-link-v1";
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

function normalize(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  return CODE_PATTERN.test(normalized) ? normalized : null;
}

/** Link /c/CODIGO: guarda o código para a sacola tentar aplicar. */
export function writeLinkCoupon(code: string): void {
  const normalized = normalize(code);
  if (!normalized) return;
  try {
    window.localStorage.setItem(LINK_KEY, normalized);
  } catch {
    // sem storage, a cliente digita na sacola
  }
}

/** Lê E apaga o código do link (a sacola tenta uma vez; o que der certo vira "aplicado"). */
export function takeLinkCoupon(): string | null {
  try {
    const raw = window.localStorage.getItem(LINK_KEY);
    window.localStorage.removeItem(LINK_KEY);
    return raw ? normalize(raw) : null;
  } catch {
    return null;
  }
}

export function readStoredCoupon(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && CODE_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Cupom aplicado na sacola (UPPERCASE); null apaga. */
export function writeStoredCoupon(code: string | null): void {
  try {
    if (code === null) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const normalized = normalize(code);
    if (!normalized) return;
    window.localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // sem storage, sem cupom guardado — a cliente digita na sacola
  }
}
