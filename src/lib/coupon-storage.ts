// O cupom que chegou pelo link /c/CODIGO (story, indicação), guardado no
// navegador para a sacola aplicar sozinha. Só o código. Todo acesso em
// try/catch: modo privado ou cota cheia não podem quebrar a vitrine.
const STORAGE_KEY = "trive-coupon-v1";
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export function readStoredCoupon(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && CODE_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Guarda o código (UPPERCASE); null apaga. */
export function writeStoredCoupon(code: string | null): void {
  try {
    if (code === null) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const normalized = code.trim().toUpperCase();
    if (!CODE_PATTERN.test(normalized)) return;
    window.localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // sem storage, sem cupom guardado — a cliente digita na sacola
  }
}
