// Aviso no celular com o painel fechado (Web Push): a chave que segura a
// cadência (uma por conversa a cada 2 min — o UNIQUE da outbox é o árbitro)
// e o texto do aviso, o mesmo do toast do painel. Puro: sem relógio, sem I/O.
import { z } from "zod";

export const PUSH_EVENT_TYPE = "push.new_message";
export const PUSH_BUCKET_MS = 120_000;
/** Vida do push nos servidores da Apple/Google: depois disso um celular desligado não recebe mais. */
export const PUSH_TTL_SECONDS = 6 * 3600;

/** `push.new_message:<conversa>:<janela de 2 min>` — a 2ª mensagem na mesma janela não gera outro aviso. */
export function pushDedupeKey(conversationId: string, at: Date): string {
  return `${PUSH_EVENT_TYPE}:${conversationId}:${Math.floor(at.getTime() / PUSH_BUCKET_MS)}`;
}

export const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable(),
  url: z.string().min(1),
  /** Uma notificação por conversa no aparelho: a nova substitui a anterior. */
  tag: z.string().min(1),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

export function pushPayloadFor(input: { conversationId: string; label: string; preview: string | null; awaitingOwner: boolean }): PushPayload {
  return {
    title: input.awaitingOwner ? `${input.label} está esperando por você` : `Nova mensagem de ${input.label}`,
    body: input.preview,
    url: `/admin/whatsapp/conversas?c=${input.conversationId}`,
    tag: `wa:${input.conversationId}`,
  };
}

/** O que a fila carrega: só ids — o handler relê a conversa na hora de mandar. */
export const pushNewMessagePayloadSchema = z.object({
  conversationId: z.uuid(),
  waMessageId: z.uuid(),
});
export type PushNewMessagePayload = z.infer<typeof pushNewMessagePayloadSchema>;
