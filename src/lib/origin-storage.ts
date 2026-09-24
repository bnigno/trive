// De onde a cliente chegou ao site, guardado no navegador para o checkout
// contar a venda à origem certa: o último link rastreável tocado (story ou
// cupom) vale por 7 dias — quem valida e aplica o prazo é o servidor
// (core/store/attribution). Todo acesso em try/catch: modo privado ou cota
// cheia não podem quebrar a vitrine.
const STORAGE_KEY = "trive-origin-v1";
/** Passou disso, nem vale mandar (o servidor recusaria): apaga. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type OriginKind = "campaign" | "coupon";

export interface BrowserOrigin {
  kind: OriginKind;
  ref: string;
  at: string;
}

/** A última entrada vence: um story novo substitui o cupom de ontem. */
export function writeOrigin(kind: OriginKind, ref: string): void {
  const value: BrowserOrigin = { kind, ref: ref.trim(), at: new Date().toISOString() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // sem storage, o pedido só fica sem origem
  }
}

/**
 * Depois de um pedido feito: a recompra de outro dia não é mérito do mesmo
 * link (a regra da ponte da Lia: um toque, no máximo um pedido).
 */
export function clearOrigin(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nada guardado, nada a apagar
  }
}

/** O que estiver guardado, no formato esperado e dentro de 7 dias; o servidor confere o resto. */
export function readOrigin(): BrowserOrigin | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      "ref" in parsed &&
      "at" in parsed &&
      (parsed.kind === "campaign" || parsed.kind === "coupon") &&
      typeof parsed.ref === "string" &&
      typeof parsed.at === "string"
    ) {
      const age = Date.now() - Date.parse(parsed.at);
      if (Number.isFinite(age) && age <= MAX_AGE_MS) return { kind: parsed.kind, ref: parsed.ref, at: parsed.at };
    }
    window.localStorage.removeItem(STORAGE_KEY);
    return undefined;
  } catch {
    return undefined;
  }
}
