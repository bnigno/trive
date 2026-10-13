// "Me vê com ela" — a OFERTA da Lia. PURO: quando ela pode oferecer, a
// pergunta tocável (um toque = vontade + consentimento DESTA prévia), os ids
// das linhas (limites da Z-API: id ≤ 64, título ≤ 24), as respostas curtas
// ao toque e o texto que o toque assume no histórico. Quem decide se
// oferece é o código (shouldOfferTryOn) — o modelo só escolhe o momento.
import type { TryOnFraming } from "./rules";

export const TRYON_ANSWERS = ["quero", "agora_nao"] as const;
export type TryOnAnswer = (typeof TRYON_ANSWERS)[number];

export const TRYON_ROW_PREFIX = "tryon:";
export const TRYON_OFFER_TITLE = "Quer se ver com ela?";
export const TRYON_OFFER_BUTTON = "Responder";

export const TRYON_ANSWER_TITLES: Record<TryOnAnswer, string> = {
  quero: "Quero me ver",
  agora_nao: "Agora não",
};

export const TRYON_OFFER_TIMING = {
  /** Uma oferta por conversa neste intervalo (a conversa é a do telefone, que dura meses). */
  reofferAfterMs: 24 * 3_600_000,
  /** Depois de um "Agora não", a Lia não volta ao assunto por este tempo (a não ser que ela peça). */
  quietAfterDeclineMs: 30 * 24 * 3_600_000,
  /** Toque numa lista mais velha que isto não vale: vira texto para a Lia (ela oferece de novo). */
  answerWindowMs: 24 * 3_600_000,
  /** Depois do "Quero me ver", a foto dela vale por este tempo. */
  photoWindowMs: 2 * 3_600_000,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `tryon:quero:<pedido>` — ≤ 64 caracteres. */
export function tryOnRowId(answer: TryOnAnswer, requestId: string): string {
  return `${TRYON_ROW_PREFIX}${answer}:${requestId}`;
}

export function parseTryOnRowId(rowId: string | null | undefined): { answer: TryOnAnswer; requestId: string } | null {
  if (!rowId || !rowId.startsWith(TRYON_ROW_PREFIX)) return null;
  const [answer, requestId, ...rest] = rowId.slice(TRYON_ROW_PREFIX.length).split(":");
  if (rest.length > 0 || !requestId || !UUID_RE.test(requestId)) return null;
  if (!(TRYON_ANSWERS as readonly string[]).includes(answer)) return null;
  return { answer: answer as TryOnAnswer, requestId };
}

/** As duas linhas: "Quero me ver" (o consentimento, com a condição dita) e "Agora não". */
export function tryOnOfferOptions(requestId: string): Array<{ id: string; title: string; description: string }> {
  return [
    { id: tryOnRowId("quero", requestId), title: TRYON_ANSWER_TITLES.quero, description: "A foto é minha e tenho 18 anos ou mais" },
    { id: tryOnRowId("agora_nao", requestId), title: TRYON_ANSWER_TITLES.agora_nao, description: "Sigo vendo as peças" },
  ];
}

/**
 * O texto da oferta: o que é, que é IA e o que acontece com a foto — antes
 * do toque (LGPD: consentimento informado, em destaque). O toque vem ANTES
 * da foto (a foto só vai para a IA com ele). Com a foto já na conversa, a
 * pergunta é sobre ELA.
 */
export function tryOnOfferBody(productName: string, withPhoto: boolean, framing: TryOnFraming | null = null): string {
  const photo = framing === "ate_cintura" ? "uma foto sua da cintura pra cima" : "uma foto sua de corpo inteiro";
  const what = withPhoto
    ? `Quer que eu te mostre ${productName} nessa sua foto? 📸`
    : `Quer ver como ${productName} fica em você? 📸 Toque em "Quero me ver" e depois me manda ${photo} — eu te devolvo vestindo.`;
  return `${what} É uma prévia feita com IA, só pra você: a sua foto vai só para a IA gerar e conferir a prévia e não fica guardada com a gente.`;
}

/** Como o envio da oferta aparece no histórico do modelo e na Central (a lista do catálogo tem outro marcador). */
export const TRYON_OFFER_HISTORY_TEXT = '[pergunta tocável enviada: "Quer se ver com ela?" (Quero me ver / Agora não)]';

/** O corpo gravado de uma oferta (wa-messaging: mensagem + linhas "• título — descrição"). */
export function isTryOnOfferBody(body: string): boolean {
  return body.includes(`• ${TRYON_ANSWER_TITLES.quero} — `) && body.includes("prévia feita com IA");
}

/** O toque, no histórico: `[resposta à prévia de VESTIDO AMORA]: Quero me ver`. */
export function tryOnAnswerHistoryText(answer: TryOnAnswer, productName: string): string {
  return `[resposta à pergunta "Quer se ver com ela?" (${productName})]: ${TRYON_ANSWER_TITLES[answer]}`;
}

/** "Agora não" com a prévia já na FASHN: não dá para parar o que foi pedido — e ela fica sabendo. */
export const TRYON_DECLINED_IN_FLIGHT_TEXT = "Tudo bem! A prévia que já estava sendo feita chega em instantes — depois disso não te ofereço mais 💛";

/** A resposta curta ao toque — sai sem a Lia precisar de turno. */
export function tryOnAnswerAckText(input: { answer: TryOnAnswer; withPhoto: boolean; framing: TryOnFraming | null }): string {
  if (input.answer === "agora_nao") return "Tudo bem! 💛 Se quiser se ver com alguma peça depois, é só me pedir.";
  if (input.withPhoto) return "Oba! Tô te vestindo — em um minutinho te mando a prévia 🪄";
  return input.framing === "ate_cintura"
    ? "Oba! Me manda uma foto sua da cintura pra cima — em pé, de frente, com boa luz e vestida da cintura pra baixo (calça, saia ou short) 📸"
    : "Oba! Me manda uma foto sua de corpo inteiro — em pé, de frente e com boa luz (pode ser no espelho) 📸";
}

export type TryOnOfferRefusal =
  | "desligado"
  | "midia_desligada"
  | "nao_veste"
  | "sem_foto_da_peca"
  | "esgotada"
  | "cor_esgotada"
  | "em_andamento"
  | "limite"
  | "ja_ofereceu"
  | "recusou";

export type TryOnOfferVerdict = { offer: true } | { offer: false; reason: TryOnOfferRefusal };

/**
 * Pode oferecer? Ordem: interruptor (e a Lia enxergando fotos), peça (roupa,
 * com estoque — na cor dita —, com foto real da cor), prévia em andamento,
 * teto do dia, oferta nesta conversa nas últimas 24 h, "Agora não" nos
 * últimos 30 dias. A cliente que PEDE (`asked`) passa por cima dos dois
 * últimos — nunca dos tetos.
 */
export function shouldOfferTryOn(input: {
  enabled: boolean;
  mediaEnabled: boolean;
  wearable: boolean;
  hasGarmentPhoto: boolean;
  inStock: boolean;
  /** Com cor escolhida: aquela cor tem estoque (e existe na peça). Sem cor: true. */
  colorInStock: boolean;
  inFlight: boolean;
  quotaOk: boolean;
  lastOfferAt: Date | null;
  lastDeclinedAt: Date | null;
  asked?: boolean;
  now: Date;
}): TryOnOfferVerdict {
  if (!input.enabled) return { offer: false, reason: "desligado" };
  if (!input.mediaEnabled) return { offer: false, reason: "midia_desligada" };
  if (!input.wearable) return { offer: false, reason: "nao_veste" };
  if (!input.inStock) return { offer: false, reason: "esgotada" };
  if (!input.colorInStock) return { offer: false, reason: "cor_esgotada" };
  if (!input.hasGarmentPhoto) return { offer: false, reason: "sem_foto_da_peca" };
  if (input.inFlight) return { offer: false, reason: "em_andamento" };
  if (!input.quotaOk) return { offer: false, reason: "limite" };
  if (input.asked) return { offer: true };
  const now = input.now.getTime();
  if (input.lastOfferAt && now - input.lastOfferAt.getTime() < TRYON_OFFER_TIMING.reofferAfterMs) return { offer: false, reason: "ja_ofereceu" };
  if (input.lastDeclinedAt && now - input.lastDeclinedAt.getTime() < TRYON_OFFER_TIMING.quietAfterDeclineMs) return { offer: false, reason: "recusou" };
  return { offer: true };
}

/** O que a ferramenta diz ao modelo quando NÃO pode oferecer (nunca citar "tentei" à cliente). */
export function offerRefusalText(reason: TryOnOfferRefusal): string {
  switch (reason) {
    case "desligado":
      return "A prévia na foto está desligada na loja: não ofereça nem comente.";
    case "midia_desligada":
      return "Você não está enxergando fotos agora (desligado na loja): não ofereça a prévia.";
    case "nao_veste":
      return "Essa peça não tem prévia na foto (só roupa tem): não ofereça; siga com a peça.";
    case "sem_foto_da_peca":
      return "Essa peça (ou essa cor) ainda não tem foto real no catálogo para a prévia: não ofereça; siga com a peça.";
    case "esgotada":
      return "Essa peça está esgotada: não ofereça a prévia; ofereça outra parecida ou avisar_quando_voltar.";
    case "cor_esgotada":
      return "Essa cor não está disponível nesta peça: não ofereça a prévia nela; mostre as cores que têm (detalhar_produto).";
    case "em_andamento":
      return "Já tem uma prévia dela sendo feita: ela chega sozinha. Não ofereça outra agora.";
    case "limite":
      return "As prévias de hoje acabaram (dela ou da loja): não ofereça; siga com cor e tamanho.";
    case "ja_ofereceu":
      return "Você já ofereceu a prévia nesta conversa nas últimas 24 h: não ofereça de novo (se ELA pedir, chame com ela_pediu).";
    case "recusou":
      return "Ela disse 'Agora não' para a prévia há pouco tempo: não ofereça de novo (se ELA pedir, chame com ela_pediu).";
  }
}
