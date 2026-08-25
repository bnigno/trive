export type Cents = number;

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function assertCents(value: number): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `Valor monetário deve ser um inteiro seguro em centavos, recebido: ${value}`,
    );
  }
}

export function formatCentsBRL(cents: Cents): string {
  assertCents(cents);
  return brlFormatter.format(cents / 100);
}

const BRL_PATTERN =
  /^(-)?(?:(\d{1,3}(?:\.\d{3})*)|(\d+))(?:,(\d{1,2}))?$/;

/**
 * Aceita 'R$ 1.234,56', '1.234,56', '1234,56', '1234', '-R$ 1,00'.
 * Vírgula é o separador decimal; ponto só como separador de milhar.
 */
export function parseBRLToCents(input: string): Cents {
  const cleaned = input.replace(/R\$/g, "").replace(/\s/g, "");
  const match = BRL_PATTERN.exec(cleaned);
  if (!match) {
    throw new RangeError(`Valor monetário inválido: ${JSON.stringify(input)}`);
  }
  const [, sign, grouped, plain, decimals] = match;
  const integerPart = (grouped ?? plain ?? "").replace(/\./g, "");
  const centsPart = (decimals ?? "").padEnd(2, "0");
  const cents = Number(integerPart) * 100 + Number(centsPart);
  assertCents(cents);
  return sign === "-" ? -cents : cents;
}

/**
 * Divide totalCents proporcionalmente aos pesos, em partes inteiras cuja
 * soma é EXATAMENTE o total (o resto do arredondamento vai no último item).
 */
export function splitProportional(
  totalCents: Cents,
  weights: number[],
): Cents[] {
  assertCents(totalCents);
  if (weights.length === 0) {
    throw new RangeError("splitProportional exige ao menos um peso");
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new RangeError("Pesos devem ser números finitos não-negativos");
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    throw new RangeError("A soma dos pesos deve ser positiva");
  }
  const parts: Cents[] = [];
  let allocated = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    const part = Math.floor((totalCents * weights[i]) / totalWeight);
    parts.push(part);
    allocated += part;
  }
  parts.push(totalCents - allocated);
  return parts;
}
