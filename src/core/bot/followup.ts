// Retorno combinado — PURO. A cliente adia ("me chama amanhã às 10"), a Lia
// pergunta se pode chamar e, com o sim, agenda. Aqui mora o que decide sem
// I/O: a data/hora pedida vira um instante dentro da janela de envio, os
// limites (nem daqui a pouco, nem daqui a semanas), o que conta como "sim",
// a mensagem sintética que abre o turno proativo e a linha do caderninho.
import { isSpDayKey, spDateTime, spDayKey, spDayLabel, spMinutesOfDay, spNextDayKey, spTimeLabel } from "@/lib/sp-day";

import type { SendWindow } from "@/core/whatsapp/send-window";

export const FOLLOWUP_KINDS = ["customer", "idle_cart"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const FOLLOWUP_MAX_DAYS = 7;
export const FOLLOWUP_MIN_MINUTES = 30;
/** Mensagens dela na hora seguinte ao "sim" ("obrigada!", "até amanhã") não cancelam o combinado; uma volta de verdade, depois disso, cancela. */
export const FOLLOWUP_GRACE_MINUTES = 60;
/** Chegou tarde demais (fila parada, modelo fora do ar): "como combinamos" horas depois soa errado — não chama. */
export const FOLLOWUP_MAX_DELAY_MS = 6 * 3_600_000;

export type FollowupPlan =
  | { ok: true; dueAt: Date; adjusted: "janela_inicio" | "dia_seguinte" | null }
  | { ok: false; reason: "data_invalida" | "hora_invalida" | "passado" | "muito_perto" | "muito_longe" };

/**
 * "2026-09-15" + "10:00" no relógio de SP → o instante do retorno. Antes da
 * janela vira a abertura do dia; depois dela, a abertura do dia seguinte.
 * Menos de 30 min é "fica na conversa"; mais de 7 dias é longe demais.
 */
export function planFollowup(input: { date: string; time: string; now: Date; window: SendWindow }): FollowupPlan {
  if (!isSpDayKey(input.date)) return { ok: false, reason: "data_invalida" };
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.time.trim());
  if (!match) return { ok: false, reason: "hora_invalida" };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false, reason: "hora_invalida" };
  const start = input.window.startHour * 60;
  const end = input.window.endHour * 60;
  let day = input.date;
  let minutesOfDay = hours * 60 + minutes;
  let adjusted: "janela_inicio" | "dia_seguinte" | null = null;
  if (minutesOfDay < start) {
    minutesOfDay = start;
    adjusted = "janela_inicio";
  } else if (minutesOfDay >= end) {
    day = spNextDayKey(day);
    minutesOfDay = start;
    adjusted = "dia_seguinte";
  }
  const dueAt = spDateTime(day, minutesOfDay);
  // "2026-02-31" passa no formato mas não existe: o instante não fecha a volta.
  if (Number.isNaN(dueAt.getTime()) || spDayKey(dueAt) !== day) return { ok: false, reason: "data_invalida" };
  const delta = dueAt.getTime() - input.now.getTime();
  if (delta < 0) return { ok: false, reason: "passado" };
  if (delta < FOLLOWUP_MIN_MINUTES * 60_000) return { ok: false, reason: "muito_perto" };
  if (delta > FOLLOWUP_MAX_DAYS * 86_400_000) return { ok: false, reason: "muito_longe" };
  return { ok: true, dueAt, adjusted };
}

/** O que a Lia diz quando o plano não fecha. */
export const FOLLOWUP_PLAN_ERRORS: Record<Exclude<FollowupPlan, { ok: true }>["reason"], string> = {
  data_invalida: "Data inválida: passe 'YYYY-MM-DD' no calendário de São Paulo (hoje é o dia do caderninho).",
  hora_invalida: "Hora inválida: passe 'HH:MM' (ex.: '10:00').",
  passado: "Esse horário já passou. Combine um horário futuro com ela.",
  muito_perto: "Menos de 30 minutos: não agende — fique na conversa e responda agora.",
  muito_longe: "Mais de 7 dias: combine algo mais perto (até uma semana) ou peça para ela chamar quando quiser.",
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function hasNegation(normalized: string): boolean {
  return /\b(nao|nunca|deixa|nem|para de|pare|jamais)\b/.test(normalized) && !/\bnao (tem|ha) problema\b/.test(normalized);
}

/**
 * A mensagem dela é um "sim" curto? Só afirmativas — nada de verbos que
 * aparecem em pedidos ("manda a foto", "quero pensar"). Vale quando a Lia
 * acabou de perguntar "posso te chamar …?".
 */
export function looksLikeConsent(text: string): boolean {
  const normalized = normalize(text);
  if (hasNegation(normalized)) return false;
  if (normalized.trim().split(/\s+/).length > 15) return false;
  return (
    /\b(sim|pode|claro|ok|okay|beleza|combinado|combina|fechado|fechou|bora|vamos|ta|tabom|tudo bem|por favor|perfeito|otimo|show|top|blz|positivo|uhum|aham|entao|pode ser|pode sim|vai la|ate la|ate amanha)\b/.test(normalized) ||
    /^(s|ss|sim+|k|kk)$/.test(normalized.trim())
  );
}

/** Ela mesma pediu ("me chama amanhã às 10", "pode me ligar depois"): é consentimento sem pergunta da Lia. */
export function isReturnRequest(text: string): boolean {
  const normalized = normalize(text);
  if (hasNegation(normalized)) return false;
  return /\b(me (chama|chame|liga|ligue|avisa|avise|lembra|lembre|procura|procure|manda (uma )?mensagem|fala)|pode(m)? me (chamar|ligar|avisar|lembrar|procurar)|chama eu|fala comigo|volta a falar comigo|me da um toque)\b/.test(normalized);
}

/** A última fala da Lia antes da resposta dela foi a pergunta de retorno? */
export function askedToCallBack(outboundText: string): boolean {
  const normalized = normalize(outboundText);
  return normalized.includes("?") && /\b(te chamo|te chamar|chamar voce|te procuro|te procurar|te aviso|te avisar|te lembro|te lembrar|posso chamar|retomo|retomar)\b/.test(normalized);
}

/** "15/09 às 10:00". */
export function followupWhenLabel(dueAt: Date): string {
  return `${spDayLabel(spDayKey(dueAt))} às ${spTimeLabel(dueAt)}`;
}

/** A linha do caderninho enquanto o retorno está agendado. */
export function followupMemoryLine(input: { dueAt: Date; reason: string }): string {
  return `Retorno combinado: você vai chamá-la em ${followupWhenLabel(input.dueAt)} (${input.reason}) — não combine outro; se ela mudar o horário, chame agendar_retorno de novo.`;
}

/**
 * A mensagem sintética (papel de usuário) que abre o turno proativo: o
 * modelo precisa de uma "fala" para responder, e ela diz exatamente o que
 * está acontecendo — a cliente pediu, o horário chegou.
 */
export function renderFollowupPrompt(input: { kind: FollowupKind; reason: string; dueAt: Date }): string {
  if (input.kind === "idle_cart") {
    return `[retomada automática: a sacola dela ficou parada — ${input.reason}. Chegou a hora de você mandar UMA mensagem gentil retomando de onde parou, com o caderninho; se ela não quiser, deixe estar.]`;
  }
  return `[retorno combinado: ela pediu que você a chamasse em ${followupWhenLabel(input.dueAt)} (${input.reason}) e chegou a hora. Chame-a agora em 1–2 frases, no seu tom, retomando de onde parou com o caderninho — sem pedir desculpa por chamar (ela pediu) e sem repetir o que já disse.]`;
}

/** Passou da hora demais para dizer "como combinamos"? */
export function isFollowupTooLate(input: { dueAt: Date; now: Date }): boolean {
  return input.now.getTime() - input.dueAt.getTime() > FOLLOWUP_MAX_DELAY_MS;
}

/** A cliente voltou por conta depois do combinado (fora da carência)? Então o retorno perdeu o sentido. */
export function isFollowupSuperseded(input: { createdAt: Date; lastInboundAt: Date | null }): boolean {
  if (!input.lastInboundAt) return false;
  return input.lastInboundAt.getTime() > input.createdAt.getTime() + FOLLOWUP_GRACE_MINUTES * 60_000;
}

/** Minutos de SP do instante — útil para o texto "às 9h, o primeiro horário". */
export function followupMinutesOfDay(dueAt: Date): number {
  return spMinutesOfDay(dueAt);
}

/** "Retomar sacola parada após N horas": 0 = desligado; teto de 7 dias. */
export const IDLE_CART_MAX_HOURS = 168;

export type IdleCartCandidateInput = {
  status: string;
  botDisabledUntil: Date | null;
  cartCount: number;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** Ela tem cadastro com opt-in de avisos? Sem cadastro ou sem opt-in, nada de mensagem comercial. */
  hasOptIn: boolean;
  /** Fez um pedido depois da última mensagem (pelo site ou pela Lia)? Então a sacola virou compra. */
  orderedAfterLastInbound: boolean;
  hours: number;
  now: Date;
};

/**
 * A sacola parada que merece UMA retomada: conversa aberta com a Lia,
 * sacola com peças, opt-in, a cliente sumiu há N horas depois de a Lia ter
 * respondido, e nenhum pedido depois disso. (Uma vez por conversa, para
 * sempre: quem garante é o UNIQUE de wa_followups.)
 */
export function isIdleCartCandidate(input: IdleCartCandidateInput): boolean {
  if (input.hours <= 0) return false;
  if (input.status !== "open") return false;
  if (input.botDisabledUntil && input.botDisabledUntil.getTime() > input.now.getTime()) return false;
  if (input.cartCount <= 0) return false;
  if (!input.hasOptIn) return false;
  if (input.orderedAfterLastInbound) return false;
  if (!input.lastInboundAt) return false;
  // A Lia respondeu por último (senão a bola está com ela, não com a cliente).
  if (!input.lastOutboundAt || input.lastOutboundAt.getTime() < input.lastInboundAt.getTime()) return false;
  return input.now.getTime() - input.lastInboundAt.getTime() >= input.hours * 3_600_000;
}

/** O motivo que vai para wa_followups e para a fala sintética. */
export function idleCartReason(cartCount: number): string {
  return cartCount === 1 ? "1 peça parada na sacola" : `${cartCount} peças paradas na sacola`;
}
