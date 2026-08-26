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
 * Celular LEGADO de 8 dígitos (começando em 6-9) ganha o nono dígito — o
 * WhatsApp (Z-API) entrega contas antigas sem o 9 (caso real em produção:
 * '+559181037536' travava a criação do pedido pelo bot).
 * Retorna null quando não reconhece um número válido.
 */
export function toE164BR(input: string): string | null {
  let digits = input.replace(/\D/g, "");

  if (digits.startsWith("00")) return null;
  // Prefixo de tronco nacional: 0 + DDD + número (11 ou 12 dígitos).
  if (digits.startsWith("0") && (digits.length === 11 || digits.length === 12)) {
    digits = digits.slice(1);
  }
  let hasCountryCode = false;
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
    hasCountryCode = true;
  }
  if (digits.length !== 10 && digits.length !== 11) return null;

  const ddd = digits.slice(0, 2);
  let subscriber = digits.slice(2);
  if (!DDD_PATTERN.test(ddd)) return null;

  // Só com o 55 explícito (formato dos JIDs do WhatsApp): digitação humana
  // sem código do país não é reinterpretada (ex.: '01 99999-8888' segue nula).
  if (hasCountryCode && subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
    subscriber = `9${subscriber}`;
  }

  const isMobile = subscriber.length === 9 && subscriber.startsWith("9");
  const isLandline = subscriber.length === 8 && /^[2-5]/.test(subscriber);
  if (!isMobile && !isLandline) return null;

  return `+55${ddd}${subscriber}`;
}
