const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const DDD_PATTERN = /^[1-9][1-9]$/;

export function isValidE164(s: string): boolean {
  return E164_PATTERN.test(s);
}

/**
 * Normaliza telefones brasileiros para E.164: '+55' + DDD + número.
 * Aceita formatos comuns ('(11) 99999-8888', '11 99999 8888', '+55...',
 * '5511999998888', '011...'), com ou sem 55, DDD obrigatório.
 * Celular: 9 dígitos começando em 9. Fixo: 8 dígitos começando em 2-5.
 * Retorna null quando não reconhece um número válido.
 */
export function toE164BR(input: string): string | null {
  let digits = input.replace(/\D/g, "");

  if (digits.startsWith("00")) return null;
  // Prefixo de tronco nacional: 0 + DDD + número (11 ou 12 dígitos).
  if (digits.startsWith("0") && (digits.length === 11 || digits.length === 12)) {
    digits = digits.slice(1);
  }
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return null;

  const ddd = digits.slice(0, 2);
  const subscriber = digits.slice(2);
  if (!DDD_PATTERN.test(ddd)) return null;

  const isMobile = subscriber.length === 9 && subscriber.startsWith("9");
  const isLandline = subscriber.length === 8 && /^[2-5]/.test(subscriber);
  if (!isMobile && !isLandline) return null;

  return `+55${ddd}${subscriber}`;
}
