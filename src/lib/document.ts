// Validação de CPF/CNPJ — algoritmos oficiais de dígito verificador (módulo 11).
// Puro: sem I/O, sem dependências.

const CPF_DV1_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_DV2_WEIGHTS = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_DV1_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_DV2_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function isRepeatedSequence(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function checkDigit(digits: string, weights: number[]): number {
  const sum = weights.reduce(
    (acc, weight, index) => acc + weight * Number(digits[index]),
    0,
  );
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Valida um CPF já sem máscara (exatamente 11 dígitos). */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || isRepeatedSequence(digits)) return false;
  if (checkDigit(digits, CPF_DV1_WEIGHTS) !== Number(digits[9])) return false;
  return checkDigit(digits, CPF_DV2_WEIGHTS) === Number(digits[10]);
}

/** Valida um CNPJ já sem máscara (exatamente 14 dígitos). */
export function isValidCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || isRepeatedSequence(digits)) return false;
  if (checkDigit(digits, CNPJ_DV1_WEIGHTS) !== Number(digits[12])) return false;
  return checkDigit(digits, CNPJ_DV2_WEIGHTS) === Number(digits[13]);
}

export type NormalizedDocument = { type: "cpf" | "cnpj"; digits: string };

/**
 * Remove a máscara ('529.982.247-25', '11.222.333/0001-81', ...) e valida.
 * Retorna o tipo + dígitos quando válido; null para qualquer entrada inválida.
 */
export function normalizeDocument(input: string): NormalizedDocument | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 11 && isValidCpf(digits)) return { type: "cpf", digits };
  if (digits.length === 14 && isValidCnpj(digits)) return { type: "cnpj", digits };
  return null;
}
