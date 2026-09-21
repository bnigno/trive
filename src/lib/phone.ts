const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const DDD_PATTERN = /^[1-9][1-9]$/;
/** LID do WhatsApp: identificador que substitui o número quando ele é oculto ('220839349862480@lid'). */
const WA_LID_PATTERN = /^\d{5,20}@lid$/;
/**
 * Id de grupo como a Z-API o entrega: '120363019502650977-group' (grupos
 * criados desde nov/2021) ou o legado 'telefone-timestamp'
 * ('5511999999999-1623281429').
 */
const WA_GROUP_ID_PATTERN = /^\d{10,20}-(group|\d{9,10})$/;

export function isValidE164(s: string): boolean {
  return E164_PATTERN.test(s);
}

/** 'xxxxx@lid' — o WhatsApp passou a esconder o número de alguns contatos; a Z-API entrega e aceita o LID no lugar do telefone. */
export function isWaLid(s: string): boolean {
  return WA_LID_PATTERN.test(s);
}

/** '120363019502650977-group' — id de grupo da Z-API (ver WA_GROUP_ID_PATTERN). */
export function isWaGroupId(s: string): boolean {
  return WA_GROUP_ID_PATTERN.test(s);
}

/**
 * Normaliza um id de grupo vindo da Z-API ou do WhatsApp Web
 * ('120363…-group', '120363…@g.us', ' 120363…-GROUP ') para o canônico
 * '…-group'; null se não for grupo. Um telefone NUNCA vira grupo.
 */
export function toWaGroupId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  const jid = value.match(/^(\d{10,20}(?:-\d{9,10})?)@g\.us$/);
  if (jid) {
    const id = jid[1] as string;
    return id.includes("-") ? id : `${id}-group`;
  }
  return isWaGroupId(value) ? value : null;
}

/**
 * Endereço de WhatsApp: o que vai no campo `phone` da Z-API — E.164
 * ('+5591…') ou LID ('…@lid'). A conversa guarda o endereço em phone_e164.
 * Grupo NÃO é endereço de conversa: tem função própria (isWaGroupId).
 */
export function isWaAddress(s: string): boolean {
  return isValidE164(s) || isWaLid(s);
}

/** Normaliza um LID vindo da Z-API ('123@lid', ' 123@LID ', '123@lid.whatsapp.net'?) para o canônico; null se não for LID. */
export function toWaLid(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().toLowerCase().match(/^(\d{5,20})@lid\b/);
  return match ? `${match[1]}@lid` : null;
}

/** O que a Z-API espera no campo `phone`: E.164 sem o '+'; LID e id de grupo como estão. */
export function waAddressForZapi(address: string): string {
  return isWaLid(address) || isWaGroupId(address) ? address : address.replace(/^\+/, "");
}

/**
 * Link wa.me a partir de um telefone em formato livre (ex.: a setting
 * store_whatsapp). Número nacional (DDD + número) ganha o 55 do Brasil;
 * E.164 vira só dígitos. `text` vai pré-preenchido na conversa.
 * Retorna null quando não há dígitos — o caller esconde o link.
 */
export function waMeUrl(rawPhone: unknown, text?: string): string | null {
  if (typeof rawPhone !== "string") return null;
  let digits = rawPhone.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  const query = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${query}`;
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

/**
 * Dois telefones são o mesmo número? Compara em E.164 quando os dois
 * normalizam (o setting do dono pode vir '(91) 98103-7536'; a Z-API manda
 * '5591981037536'); senão, pelos dígitos.
 */
export function sameE164(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = toE164BR(a) ?? `+${a.replace(/\D/g, "")}`;
  const right = toE164BR(b) ?? `+${b.replace(/\D/g, "")}`;
  return left.length > 1 && left === right;
}

/** '+5511999991234' -> '(11) 99999-1234' — para o painel e o material impresso. LID (número oculto) não tem número. */
export function formatPhoneBR(phoneE164: string): string {
  if (isWaLid(phoneE164)) return "número oculto pelo WhatsApp";
  const digits = phoneE164.replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 13 || digits.length === 12)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return phoneE164;
}

/** '+5511999991234' -> '(11) •••••-1234' — nunca expõe o número inteiro. LID (número oculto) não tem o que mascarar. */
export function maskPhone(phoneE164: string): string {
  if (isWaLid(phoneE164)) return "número oculto";
  const last4 = phoneE164.slice(-4);
  if (phoneE164.startsWith("+55") && phoneE164.length >= 12) {
    const ddd = phoneE164.slice(3, 5);
    return `(${ddd}) •••••-${last4}`;
  }
  return `•••• ${last4}`;
}
