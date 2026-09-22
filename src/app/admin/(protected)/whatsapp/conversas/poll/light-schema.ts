// O poll leve (`?light=1`) alimenta o crachá do menu, o título da aba e os
// avisos de qualquer página do painel. Um schema só para os dois lados da
// rede: a rota devolve o tipo, o cliente faz parse (nunca cast).
import { z } from "zod";

export const lightPollUnseenSchema = z.object({
  id: z.string(),
  /** Nome do cadastro, senão o do WhatsApp, senão o telefone mascarado. */
  label: z.string(),
  status: z.string(),
  /** Espera uma pessoa: transferida, vendedora em pausa ou desligada. */
  awaitingOwner: z.boolean(),
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

export { inboundPreview } from "@/lib/wa-preview";
