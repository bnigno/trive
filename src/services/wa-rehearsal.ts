// "Testar a vendedora": um turno de ensaio com o prompt e o catálogo reais,
// sem conversa gravada e sem efeito externo (dryRun) — o dono sente o tom
// antes de salvar as instruções. Custa centavos por mensagem (API real).
import { z } from "zod";

import type { BotChatMessage, SalesAssistant } from "@/adapters/assistant";
import { splitBotReply } from "@/core/bot/reply";
import type { DbOrTx } from "@/queue/enqueue";
import {
  assembleHistory,
  buildBotPromptBundle,
  buildToolExecutor,
  type BotAttachment,
} from "@/services/wa-bot";

const rehearsalSchema = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().trim().min(1).max(4000),
      }),
    )
    .max(40),
  message: z.string().trim().min(1).max(1000),
});

export type RehearsalInput = z.input<typeof rehearsalSchema>;

export interface RehearsalTurn {
  bubbles: string[];
  attachments: BotAttachment[];
  toolCalls: { name: string; ok: boolean }[];
  handedOff: boolean;
  usage: { inputTokens: number; outputTokens: number };
  sellerName: string;
  durationMs: number;
}

// Telefone fictício: nunca bate com cadastro real, então buscar_cadastro e
// status_do_pedido respondem "sem cadastro" — como para uma cliente nova.
const REHEARSAL_PHONE = "+5500000000000";

export async function rehearseBotTurn(
  db: DbOrTx,
  assistant: SalesAssistant,
  input: RehearsalInput,
): Promise<RehearsalTurn> {
  const parsed = rehearsalSchema.parse(input);
  const bundle = await buildBotPromptBundle(db);

  const messages: BotChatMessage[] = [
    ...parsed.history,
    { role: "user", text: parsed.message },
  ];
  const attachments: BotAttachment[] = [];
  const executeTool = buildToolExecutor(db, {
    conversationId: "00000000-0000-4000-8000-0000000000e5",
    phoneE164: REHEARSAL_PHONE,
    customerId: null,
    lastInboundId: "00000000-0000-4000-8000-0000000000e5",
    onAttachment: (attachment) => attachments.push(attachment),
    dryRun: true,
  });

  const startedAt = Date.now();
  const turn = await assistant.respondTurn({
    system: bundle.system,
    history: assembleHistory({}, messages),
    model: bundle.model,
    executeTool,
  });

  return {
    bubbles: turn.reply ? splitBotReply(turn.reply) : [],
    attachments,
    toolCalls: turn.toolCalls,
    handedOff: turn.handedOff,
    usage: { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens },
    sellerName: bundle.sellerName,
    durationMs: Date.now() - startedAt,
  };
}
