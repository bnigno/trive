// A Lia no grupo e o que o grupo deixa no caderninho dela. Puro.
//
// No grupo ela fala baixo: só quando chamada, com o que o catálogo diz, e
// leva o resto para o privado. Aqui moram a mensagem sintética que o modelo
// recebe, o texto final com a menção, o comando "só privado" e as linhas
// que voto/reação/menção viram no caderninho da cliente.
import { spDayKey, spWeekdayName } from "@/lib/sp-day";

import type { GroupPostKind } from "@/core/groups/cadence";
import { decodePollVote, type GroupSignalKind } from "@/core/groups/signals";

/** "só privado", "SO PRIVADO", "somente privado", "apenas no privado" — a membra quer sair do grupo e continuar no privado. */
export function isSoPrivadoCommand(text: string): boolean {
  const folded = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ");
  return /^(so|somente|apenas)( no| pelo| o)? privado$/.test(folded);
}

/** O que o modelo recebe como fala da participante: quem, em que grupo, o texto — e nada mais. */
export function renderMentionUserMessage(input: { groupName: string; senderName: string | null; text: string }): string {
  const who = input.senderName?.trim() ? input.senderName.trim() : "uma membra";
  return `[No grupo "${input.groupName}", ${who} chamou você:] ${input.text.trim()}`;
}

/**
 * O texto que sai no grupo: com o telefone dela conhecido, a menção
 * (@número — a Z-API liga ao contato); número oculto (LID), só a citação da
 * mensagem já mostra a quem é.
 */
export function renderMentionReplyBody(input: { reply: string; participantPhoneDigits: string | null }): string {
  const reply = input.reply.trim();
  return input.participantPhoneDigits ? `@${input.participantPhoneDigits} ${reply}` : reply;
}

const KIND_LABEL: Record<GroupPostKind, string> = {
  chegadas: "Passou pelo Provador",
  enquete: "enquete",
  quem_vestiu: "Quem vestiu",
  cortina: "cortina",
  livre: "post",
};

export interface GroupSignalForMemory {
  kind: GroupSignalKind;
  value: string;
  createdAt: Date;
  /** O post a que o sinal se refere (nulo para menção/mensagem solta). */
  postKind: GroupPostKind | null;
  postAt: Date | null;
  /** Nomes das peças do post (chegadas/cortina). */
  productNames: readonly string[];
}

/** Limite de linhas do Provador no caderninho: o resto do caderninho importa mais. */
export const GROUP_MEMORY_MAX_LINES = 3;

function dayLabel(at: Date): string {
  const key = spDayKey(at);
  const [, month, day] = key.split("-");
  return `${spWeekdayName(key).replace("-feira", "")} ${day}/${month}`;
}

/**
 * "Provador: votou «Verde» na enquete de quinta 24/09", "Provador: reagiu ❤️
 * ao Passou pelo Provador de terça 22/09 (Vestido Terracota, Calça Areia)",
 * "Provador: perguntou no grupo «tem em M?» (terça 22/09)". Os mais
 * recentes primeiro; voto retirado e reação removida não entram.
 */
export function groupSignalMemoryLines(signals: readonly GroupSignalForMemory[]): string[] {
  const lines: string[] = [];
  const sorted = [...signals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const signal of sorted) {
    if (lines.length >= GROUP_MEMORY_MAX_LINES) break;
    const when = signal.postAt ? dayLabel(signal.postAt) : dayLabel(signal.createdAt);
    const pieces = signal.productNames.length > 0 ? ` (${signal.productNames.join(", ")})` : "";
    if (signal.kind === "poll_vote") {
      const options = decodePollVote(signal.value);
      if (options.length === 0) continue;
      lines.push(`Provador: votou «${options.join("», «")}» na enquete de ${when}`);
    } else if (signal.kind === "reaction") {
      if (signal.value === "") continue;
      const label = signal.postKind ? KIND_LABEL[signal.postKind] : "post";
      lines.push(`Provador: reagiu ${signal.value} ao ${label} de ${when}${pieces}`);
    } else if (signal.kind === "mention") {
      const text = signal.value.trim().replace(/\s+/g, " ");
      const short = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      lines.push(`Provador: chamou você no grupo (${when}): «${short}»`);
    }
  }
  return lines;
}
