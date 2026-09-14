// A cartela no navegador: só o token e o nome poético (nada de dados). Todo
// acesso ao localStorage em try/catch; leitura por useSyncExternalStore.
export const STYLE_STORAGE_KEY = "trive-style-v1";

export interface StoredStyle {
  token: string;
  paletteName: string;
  savedAt: string;
  /** A credencial das medidas do corpo — só o navegador que gravou a tem. */
  bodyToken?: string;
}

export function readStoredStyle(): StoredStyle | null {
  try {
    const raw = window.localStorage.getItem(STYLE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredStyle>;
    if (typeof parsed.token !== "string" || typeof parsed.paletteName !== "string") return null;
    return {
      token: parsed.token,
      paletteName: parsed.paletteName,
      savedAt: String(parsed.savedAt ?? ""),
      ...(typeof parsed.bodyToken === "string" ? { bodyToken: parsed.bodyToken } : {}),
    };
  } catch {
    return null;
  }
}

export function writeStoredStyle(value: StoredStyle | null): void {
  try {
    if (value) window.localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(STYLE_STORAGE_KEY);
    window.dispatchEvent(new Event("trive-style-change"));
  } catch {
    // navegador sem storage: a cartela vive só nesta visita
  }
}

export function subscribeStoredStyle(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener("trive-style-change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("trive-style-change", callback);
  };
}

/** Snapshot estável para useSyncExternalStore (string, comparável por valor). */
export function storedStyleSnapshot(): string {
  try {
    return window.localStorage.getItem(STYLE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
