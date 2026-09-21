// Códigos legíveis para os cupons emitidos pela casa: "MARIA-K7X2M". O
// prefixo vem do primeiro nome (sem acento, só A–Z); o sufixo evita letras
// que se confundem no papel e na tela (0/O, 1/I/L).

const SUFFIX_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const COUPON_SUFFIX_LENGTH = 5;
const PREFIX_MAX = 12;
export const DEFAULT_COUPON_PREFIX = "TRIVE";

/** "María José da Silva" → "MARIA"; vazio ou sem letras → "TRIVE". */
export function couponCodePrefix(fullName: string | null | undefined, fallback = DEFAULT_COUPON_PREFIX): string {
  const first = (fullName ?? "")
    .trim()
    .split(/\s+/)
    .find((token) => /\p{L}/u.test(token));
  if (!first) return fallback;
  const ascii = first
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return ascii === "" ? fallback : ascii.slice(0, PREFIX_MAX);
}

/** Sufixo aleatório; `random` é injetado (0 ≤ random() < 1) para os testes. */
export function couponCodeSuffix(random: () => number = Math.random, length = COUPON_SUFFIX_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)] ?? "A";
  }
  return out;
}

export function buildCouponCode(prefix: string, suffix: string): string {
  return `${prefix}-${suffix}`;
}
