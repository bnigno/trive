// Âncoras do histórico do WhatsApp: a mensagem da cliente que cada saída
// respondeu. Para a Lia ela vem no dedupe (`wa.bot_reply:<inbound>`); a
// sugestão aprovada no copiloto sai com `…:suggestion:<id>` e a âncora está
// na tabela de sugestões. Módulo pequeno, sem dependências pesadas, para o
// turno (wa-bot) e o painel (wa-conversations) usarem a mesma regra.
import { inArray } from "drizzle-orm";

import { waSuggestions } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

const SUGGESTION_DEDUPE = /^wa\.bot_(?:reply|media|handoff_notice):suggestion:([0-9a-f-]{36})/i;

export async function withSuggestionAnchors<T extends { dedupeKey: string | null }>(db: DbOrTx, rows: readonly T[]): Promise<(T & { answers?: string | null })[]> {
  const idOf = (dedupeKey: string | null) => SUGGESTION_DEDUPE.exec(dedupeKey ?? "")?.[1] ?? null;
  const ids = [...new Set(rows.map((row) => idOf(row.dedupeKey)).filter((id): id is string => id !== null))];
  if (ids.length === 0) return [...rows];
  const found = await db.select({ id: waSuggestions.id, inboundMessageId: waSuggestions.inboundMessageId }).from(waSuggestions).where(inArray(waSuggestions.id, ids));
  const anchors = new Map(found.map((row) => [row.id, row.inboundMessageId]));
  return rows.map((row) => {
    const id = idOf(row.dedupeKey);
    return id ? { ...row, answers: anchors.get(id) ?? null } : row;
  });
}
