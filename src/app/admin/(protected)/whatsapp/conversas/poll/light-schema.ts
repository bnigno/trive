// O poll leve (`?light=1`) alimenta o crachá do menu, o título da aba e os
// avisos de qualquer página do painel. Um schema só para os dois lados da
// rede: a rota devolve o tipo, o cliente faz parse (nunca cast).
import { z } from "zod";

export const lightPollUnseenSchema = z.object({
  id: z.string(),
  /** Nome do cadastro, senão o do WhatsApp, senão o telefone mascarado. */
  label: z.string(),
  status: z.string(),
  /** Prévia da última mensagem recebida (corpo ou marcador de mídia). */
  preview: z.string().nullable(),
  /** Quando a última mensagem recebida chegou — a chave do "uma vez por mensagem". */
  lastInboundAt: z.string().nullable(),
});

export const lightPollResponseSchema = z.object({
  serverTime: z.string(),
  /** Conversas transferidas para o dono com mensagem não vista. */
  awaitingOwner: z.number().int().nonnegative(),
  /** Conversas com mensagem não vista em qualquer status aberto (inclui as de cima). */
  withNewMessages: z.number().int().nonnegative(),
  unseen: z.array(lightPollUnseenSchema),
  suggestionCount: z.number().int().nonnegative(),
  suggestions: z.array(z.object({ id: z.string(), label: z.string() })),
});

export type LightPollResponse = z.infer<typeof lightPollResponseSchema>;
export type LightPollUnseen = z.infer<typeof lightPollUnseenSchema>;

/** Prévia curta para toast e aviso de sistema: uma linha, sem quebra, no máximo 120 caracteres. */
export function inboundPreview(body: string | null | undefined): string | null {
  const oneLine = (body ?? "").replace(/\s+/g, " ").trim();
  if (oneLine === "") return null;
  return oneLine.length > 120 ? `${oneLine.slice(0, 119).trimEnd()}…` : oneLine;
}
