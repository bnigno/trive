// Smoke do vendedor IA com a API REAL da Anthropic: UM turno ("o que vocês
// vendem?") com as ferramentas reais em modo leitura. Valida chave, modelo e
// o loop agêntico completo antes de ligar o bot em produção. Custa centavos.
// Uso: ANTHROPIC_API_KEY=... npx tsx --env-file=.env.local scripts/smoke-bot-real.ts
import { randomUUID } from "node:crypto";

import { ClaudeSalesAssistant } from "@/adapters/assistant/claude";
import { buildBotSystemPrompt } from "@/core/bot/prompt";
import { getDb } from "@/db/client";
import { buildToolExecutor } from "@/services/wa-bot";
import { siteBaseUrl } from "@/services/wa-messaging";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("Defina ANTHROPIC_API_KEY no ambiente para o smoke real.");
  }

  const db = getDb();
  const assistant = new ClaudeSalesAssistant();
  const executeTool = buildToolExecutor(db, {
    conversationId: randomUUID(),
    phoneE164: "+5511900000000",
    customerId: null,
    // Smoke sem inbound real: id sintético só para os dedupes das ferramentas.
    lastInboundId: randomUUID(),
  });

  const turn = await assistant.respondTurn({
    system: buildBotSystemPrompt({
      storeName: "TRIVË",
      extraInstructions: "",
      siteUrl: siteBaseUrl(),
    }),
    history: [{ role: "user", text: "Oi! O que vocês vendem?" }],
    model: "claude-sonnet-5",
    executeTool,
  });

  console.log("ferramentas chamadas:", turn.toolCalls);
  console.log("uso de tokens:", turn.usage);
  console.log("---\nresposta do vendedor:\n" + (turn.reply ?? "(sem resposta)"));
  if (!turn.reply) throw new Error("Turno sem resposta — investigue antes de ativar.");
  if (turn.toolCalls.length === 0) {
    console.warn(
      "Aviso: o modelo respondeu sem consultar ferramentas — releia a resposta acima.",
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Smoke falhou:", error);
  process.exit(1);
});
