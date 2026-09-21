// O que o grupo devolve: voto em enquete, reação, menção à Lia ou só uma
// mensagem qualquer. Aqui o payload do webhook (já parseado pelo serviço)
// vira um SINAL tipado, com quem sinalizou como endereço de conversa (E.164
// ou LID). Conversa de grupo NÃO é guardada (LGPD): de uma mensagem comum
// fica só o fato. Puro.
import { toWaGroupId, toWaLid, zapiPhoneToE164 } from "@/lib/phone";

export type GroupSignalKind = "poll_vote" | "reaction" | "mention" | "message";

export interface GroupInboundPayload {
  messageId: string;
  /** O campo `phone` do webhook: em grupo é o id do grupo. */
  chatId: string;
  participantPhone?: string | null;
  participantLid?: string | null;
  fromMe?: boolean | null;
  text?: string | null;
  pollVote?: { pollMessageId?: string | null; options?: readonly { name?: string | null }[] | null } | null;
  reaction?: {
    value?: string | null;
    reactionBy?: string | null;
    referencedMessage?: { messageId?: string | null } | null;
  } | null;
}

export interface GroupSignal {
  kind: GroupSignalKind;
  groupId: string;
  /** Endereço de quem sinalizou: E.164 ('+5591…') ou LID ('…@lid'). */
  participant: string;
  /** LID à parte, quando o webhook o traz junto do telefone. */
  participantLid: string | null;
  providerMessageId: string;
  /** Enquete votada ou mensagem reagida; null para menção e mensagem. */
  referencedMessageId: string | null;
  /**
   * poll_vote: JSON das opções marcadas (vazio = voto retirado); reaction: o
   * emoji (vazio = removida); mention: o texto; message: "".
   */
  value: string;
}

/**
 * Telefone do webhook ('5591…', com ou sem '+', ou LID) → endereço de
 * conversa, pela MESMA régua do webhook 1:1 (celular legado ganha o nono
 * dígito — senão a membra nunca casa com a conversa/cadastro dela).
 */
export function participantAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  return toWaLid(value) ?? zapiPhoneToE164(value);
}

/** Voto retirado (nenhuma opção) é a string vazia — o contrato de `value`. */
export function encodePollVote(options: readonly string[]): string {
  return options.length === 0 ? "" : JSON.stringify(options);
}

export function decodePollVote(value: string): string[] {
  if (value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * "@Lia" (o nome da vendedora, sem distinguir acento/caixa) ou "@<número da
 * loja>" (como o WhatsApp escreve a menção) no texto.
 */
export function isMentionOfSeller(text: string, input: { sellerName: string; storePhoneDigits?: string | null }): boolean {
  const folded = fold(text);
  const name = fold(input.sellerName);
  if (name !== "" && new RegExp(`(^|\\s)@${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u").test(folded)) return true;
  const digits = input.storePhoneDigits?.replace(/\D/g, "") ?? "";
  return digits.length >= 8 && folded.includes(`@${digits}`);
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classifica um evento de grupo. Devolve null quando não é sinal de gente:
 * eco das nossas mensagens (fromMe), sem participante identificável, ou
 * chat que não é grupo.
 */
export function parseGroupInbound(
  payload: GroupInboundPayload,
  opts: { sellerName: string; storePhoneDigits?: string | null },
): GroupSignal | null {
  if (payload.fromMe === true) return null;
  const groupId = toWaGroupId(payload.chatId);
  if (!groupId) return null;
  const lid = toWaLid(payload.participantLid) ?? toWaLid(payload.participantPhone);
  const participant =
    participantAddress(payload.participantPhone) ??
    participantAddress(payload.reaction?.reactionBy) ??
    lid;
  if (!participant) return null;
  const providerMessageId = payload.messageId.trim();
  if (providerMessageId === "") return null;
  const base = { groupId, participant, participantLid: participant === lid ? null : lid, providerMessageId };

  if (payload.pollVote) {
    const options = (payload.pollVote.options ?? [])
      .map((option) => option.name?.trim() ?? "")
      .filter((name) => name !== "");
    return {
      ...base,
      kind: "poll_vote",
      referencedMessageId: payload.pollVote.pollMessageId?.trim() || null,
      value: encodePollVote(options),
    };
  }

  if (payload.reaction) {
    return {
      ...base,
      kind: "reaction",
      referencedMessageId: payload.reaction.referencedMessage?.messageId?.trim() || null,
      value: payload.reaction.value?.trim() ?? "",
    };
  }

  const text = payload.text?.trim() ?? "";
  if (text !== "" && isMentionOfSeller(text, opts)) {
    return { ...base, kind: "mention", referencedMessageId: null, value: text };
  }
  return { ...base, kind: "message", referencedMessageId: null, value: "" };
}
