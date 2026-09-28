// "Número sem WhatsApp" quase sempre é erro de digitação no checkout: a
// cliente de verdade costuma estar falando com a Lia por outro número que
// difere por um dígito. PURO: compara só os dígitos.

/** Brasil: com o 9 da frente (13 dígitos) ou sem (12, conta antiga do WhatsApp). */
function withoutNinthDigit(digits: string): string | null {
  return digits.length === 13 && digits.startsWith("55") && digits[4] === "9" ? digits.slice(0, 4) + digits.slice(5) : null;
}

/**
 * Os dois números parecem o mesmo com um erro de digitação: um dígito
 * trocado, dois vizinhos invertidos, ou o 9 da frente a mais/a menos.
 * Números iguais não são "erro".
 */
export function looksLikePhoneTypo(a: string, b: string): boolean {
  const x = a.replace(/\D/g, "");
  const y = b.replace(/\D/g, "");
  if (x.length < 10 || y.length < 10 || x === y) return false;
  if (x.length !== y.length) {
    const [longer, shorter] = x.length > y.length ? [x, y] : [y, x];
    return withoutNinthDigit(longer) === shorter;
  }
  const diffs: number[] = [];
  for (let index = 0; index < x.length; index += 1) {
    if (x[index] !== y[index]) diffs.push(index);
    if (diffs.length > 2) return false;
  }
  if (diffs.length === 1) return true;
  const [first, second] = diffs as [number, number];
  return second === first + 1 && x[first] === y[second] && x[second] === y[first];
}

/** Dos números que falaram com a loja, o ÚNICO que parece erro de digitação do número do pedido (nenhum ou vários = null). */
export function likelyIntendedPhone(orderPhone: string, candidates: readonly string[]): string | null {
  const matches = [...new Set(candidates)].filter((candidate) => looksLikePhoneTypo(orderPhone, candidate));
  return matches.length === 1 ? (matches[0] as string) : null;
}
