// Devolve uma conversa do WhatsApp ao robô (mesmo efeito do botão "Devolver
// ao robô" no painel) — para ativação assistida sem depender do navegador.
// Uso: npx tsx --env-file=.env.prod.local scripts/return-to-bot.ts [+55DDDNUMERO]
// Sem argumento: lista as conversas não-fechadas e não altera nada.
import { desc, eq, ne } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users, waConversations } from "@/db/schema";
import { returnWaConversationToBot } from "@/services/wa-conversations";

async function main() {
  const phone = process.argv[2];
  const db = getDb();

  const conversations = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      updatedAt: waConversations.updatedAt,
    })
    .from(waConversations)
    .where(ne(waConversations.status, "closed"))
    .orderBy(desc(waConversations.updatedAt))
    .limit(20);

  if (!phone) {
    console.table(conversations);
    console.log("Passe o telefone E.164 para devolver a conversa ao robô.");
    process.exit(0);
  }

  const target = conversations.find((c) => c.phoneE164 === phone);
  if (!target) {
    console.error(`Nenhuma conversa aberta para ${phone}. Conversas atuais:`);
    console.table(conversations);
    process.exit(1);
  }

  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "owner"))
    .limit(1);
  if (!owner) throw new Error("Nenhum usuário owner no banco.");

  await returnWaConversationToBot(db, {
    conversationId: target.id,
    userId: owner.id,
  });
  console.log(
    `Conversa ${target.id} (${phone}) devolvida ao robô — ele responde na próxima mensagem.`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("Falhou:", error);
  process.exit(1);
});
