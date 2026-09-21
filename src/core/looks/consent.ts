// "Quem já vestiu" — PURO. A pergunta tocável de consentimento, os ids das
// linhas da lista (limites da Z-API: id ≤ 64, título ≤ 24), quando uma foto
// pode aparecer na vitrine e os textos do cartão e da conversa.

export const LOOK_CONSENT_ANSWERS = ["sim", "nao"] as const;
export type LookConsentAnswer = (typeof LOOK_CONSENT_ANSWERS)[number];

export const LOOK_ROW_PREFIX = "look:";
export const CUSTOMER_LOOK_EYEBROW = "QUEM JÁ VESTIU";
export const LOOK_CONSENT_TITLE = "Posso mostrar na página?";
export const LOOK_CONSENT_BUTTON = "Responder";
export const LOOK_DISPLAY_NAME_MAX = 40;

export const LOOK_CONSENT_TITLES: Record<LookConsentAnswer, string> = {
  sim: "Sim, pode",
  nao: "Prefiro que não",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `look:sim:<lookId>` — ≤ 64 caracteres. */
export function lookRowId(answer: LookConsentAnswer, lookId: string): string {
  return `${LOOK_ROW_PREFIX}${answer}:${lookId}`;
}

export function parseLookRowId(rowId: string | null | undefined): { answer: LookConsentAnswer; lookId: string } | null {
  if (!rowId || !rowId.startsWith(LOOK_ROW_PREFIX)) return null;
  const [answer, lookId, ...rest] = rowId.slice(LOOK_ROW_PREFIX.length).split(":");
  if (rest.length > 0 || !lookId || !UUID_RE.test(lookId)) return null;
  if (!(LOOK_CONSENT_ANSWERS as readonly string[]).includes(answer)) return null;
  return { answer: answer as LookConsentAnswer, lookId };
}

/** As duas linhas da lista: "Sim, pode" / "Prefiro que não". */
export function lookConsentOptions(lookId: string): Array<{ id: string; title: string; description?: string }> {
  return [
    { id: lookRowId("sim", lookId), title: LOOK_CONSENT_TITLES.sim, description: "A foto entra em “Quem já vestiu”, com seu primeiro nome." },
    { id: lookRowId("nao", lookId), title: LOOK_CONSENT_TITLES.nao, description: "Fica só entre nós — o cartão é seu." },
  ];
}

/** A pergunta que vai com a lista, depois do cartão — deixa claro que a foto já está guardada e que ela retira quando quiser. */
export function lookConsentBody(productName: string): string {
  return `Guardei a sua foto para montar o cartão. Posso mostrá-la na página do ${productName}, em “Quem já vestiu”, com o seu primeiro nome? Você retira quando quiser — é só me pedir (e aí apago a foto também).`;
}

/** Só com o "sim" dela, a aprovação da dona e sem retirada. */
export function isLookPublic(look: { consentAnswer: string | null; approvedAt: Date | null; rejectedAt: Date | null; revokedAt: Date | null }): boolean {
  return look.consentAnswer === "sim" && look.approvedAt !== null && look.rejectedAt === null && look.revokedAt === null;
}

/** O primeiro nome, com inicial maiúscula e no teto do banco ("Ana", "Maria Clara" → "Maria"). */
export function lookDisplayName(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first === "") return LOOK_DISPLAY_NAME_FALLBACK;
  const pretty = first.charAt(0).toLocaleUpperCase("pt-BR") + first.slice(1).toLocaleLowerCase("pt-BR");
  return pretty.slice(0, LOOK_DISPLAY_NAME_MAX);
}

export const LOOK_DISPLAY_NAME_FALLBACK = "Cliente";

/** "Ana veste Longo Dunas" — sem nome, "Uma cliente veste Longo Dunas". */
export function lookCardTitle(displayName: string, productName: string): string {
  return `${displayName === LOOK_DISPLAY_NAME_FALLBACK ? "Uma cliente" : displayName} veste ${productName}`;
}

/** A legenda do cartão no WhatsApp dela (com a linha do mimo, quando houve). */
export function lookCardCaption(displayName: string, productName: string, couponLine: string | null = null): string {
  const greeting = displayName === LOOK_DISPLAY_NAME_FALLBACK ? "Ficou lindo em você" : `${displayName}, ficou lindo em você`;
  const caption = `${greeting} 🤎 Fizemos este cartão com a sua foto no ${productName} — é seu, para guardar ou postar.`;
  return couponLine ? `${caption}\n${couponLine}` : caption;
}

/** O que a Lia (e o painel) leem no histórico quando o toque volta. */
export function lookConsentHistoryText(answer: LookConsentAnswer, productName: string): string {
  return `[resposta a "${LOOK_CONSENT_TITLE}" da foto com ${productName}]: ${LOOK_CONSENT_TITLES[answer]}`;
}

/** A confirmação curta que sai pela fila depois do toque (`changed` = ela mudou de ideia). */
export function lookConsentAckText(answer: LookConsentAnswer, changed = false): string {
  if (answer === "sim") {
    return "Obrigada 🤎 A foto entra na página assim que a equipe conferir. Se mudar de ideia, é só me pedir para retirar.";
  }
  return changed ? "Tudo bem, retirei 🤎 A foto não aparece na página; o cartão continua seu." : "Tudo bem, fica só entre nós 🤎 O cartão é seu.";
}
