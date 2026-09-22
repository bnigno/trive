// Aviso no celular com o painel fechado (Web Push): a chave que segura a
// cadência (uma por conversa a cada 2 min — o UNIQUE da outbox é o árbitro)
// e o texto do aviso, o mesmo do toast do painel. Puro: sem relógio, sem I/O.
import { z } from "zod";

export const PUSH_EVENT_TYPE = "push.new_message";
export const PUSH_BUCKET_MS = 120_000;
/** Vida do push nos servidores da Apple/Google: depois disso um celular desligado não recebe mais. */
export const PUSH_TTL_SECONDS = 6 * 3600;

/**
 * `push.new_message:<conversa>:<janela de 2 min>:<última leitura>` — a 2ª
 * mensagem na mesma janela não gera outro aviso… a menos que o dono tenha
 * lido a conversa nesse meio-tempo (a leitura muda a chave): quem leu e
 * fechou o painel merece saber da resposta que chegou logo depois.
 */
export function pushDedupeKey(conversationId: string, at: Date, ownerLastSeenAt: Date | null): string {
  const seen = ownerLastSeenAt ? Math.floor(ownerLastSeenAt.getTime() / 1000) : 0;
  return `${PUSH_EVENT_TYPE}:${conversationId}:${Math.floor(at.getTime() / PUSH_BUCKET_MS)}:${seen}`;
}

export const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable(),
  url: z.string().min(1),
  /** Uma notificação por conversa no aparelho: a nova substitui a anterior (mesmo tag do aviso da aba, em use-notify). */
  tag: z.string().min(1),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

export function pushPayloadFor(input: { conversationId: string; label: string; preview: string | null; awaitingOwner: boolean }): PushPayload {
  return {
    title: input.awaitingOwner ? `${input.label} está esperando por você` : `Nova mensagem de ${input.label}`,
    body: input.preview,
    url: `/admin/whatsapp/conversas?c=${input.conversationId}`,
    tag: input.conversationId,
  };
}

/**
 * O que a fila carrega: só ids — o handler relê a conversa na hora de mandar.
 * `sentTo` cresce a cada aparelho que recebeu: a repetição depois de uma falha
 * transitória pula quem já vibrou.
 */
export const pushNewMessagePayloadSchema = z.object({
  conversationId: z.uuid(),
  waMessageId: z.uuid(),
  sentTo: z.array(z.uuid()).default([]),
});
/** Entrada do service: `sentTo` é opcional (quem enfileira não manda; o handler manda o que o evento acumulou). */
export type PushNewMessagePayload = z.input<typeof pushNewMessagePayloadSchema>;
