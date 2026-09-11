// Máscara de CEP para os campos da vitrine (sacola e checkout): só dígitos,
// no máximo 8, com o hífen depois do quinto. Puro; a validação fica no
// service (normalizeCep).
export function formatCep(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

/** Só os 8 dígitos, ou null quando o valor não forma um CEP completo. */
export function cepDigits(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}
