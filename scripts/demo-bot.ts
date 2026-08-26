// Roteiro E2E do BOT DE VENDAS IA (Fase 5, modo simulado): cliente conversa
// no WhatsApp, o robô mostra o catálogo, detalha produto, cota frete, CRIA o
// pedido com link de pagamento — e transfere para atendente quando pedido.
// O assistente é o fake roteirizável: as FERRAMENTAS executadas são as reais
// (catálogo, frete, createStoreOrder canal whatsapp), só a "conversa" da IA
// é ensaiada — nenhuma chamada à API da Anthropic acontece aqui.
// Uso: ADAPTER_MODE=fake npx tsx --env-file=.env.local scripts/demo-bot.ts
import { desc, eq, sql } from "drizzle-orm";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { getSalesAssistant } from "@/adapters/assistant";
import { getMessagingProvider } from "@/adapters/zapi";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { drainOutbox } from "@/queue/worker";
import {
  getPublicProductBySlug,
  listPublicProducts,
} from "@/services/store-catalog";
import { processZapiInbound } from "@/services/wa-inbound";

const OWNER_PHONE = "+5511900001111";
const CLIENT_PHONE_ZAPI = "5511922221111";
const CLIENT_PHONE_E164 = "+5511922221111";
const SECRET = process.env.ZAPI_WEBHOOK_SECRET?.trim() || "demo-bot-secret";

let messageSequence = 0;

function inboundText(text: string) {
  messageSequence += 1;
  return {
    providedSecret: SECRET,
    body: {
      type: "ReceivedCallback",
      instanceId: "demo-bot",
      messageId: `DEMO-BOT-${Date.now()}-${messageSequence}`,
      phone: CLIENT_PHONE_ZAPI,
      fromMe: false,
      isGroup: false,
      senderName: "Cliente do Demo",
      momment: Date.now(),
      status: "RECEIVED",
      text: { message: text },
    },
  };
}

async function drainAll(db: ReturnType<typeof getDb>) {
  await db.execute(
    sql`update outbox_events set next_attempt_at = now() - interval '1 second' where status in ('pending','failed')`,
  );
  return drainOutbox(db, { limit: 50 });
}

function lastClientMessage(wa: FakeMessagingProvider): string {
  const message = [...wa.sentMessages]
    .reverse()
    .find((sent) => sent.toE164 === CLIENT_PHONE_E164);
  if (!message) throw new Error("Nenhuma resposta enviada ao cliente");
  return message.body;
}

async function main() {
  process.env.ZAPI_WEBHOOK_SECRET = SECRET;
  const db = getDb();
  const wa = getMessagingProvider();
  const assistant = getSalesAssistant();
  if (!(wa instanceof FakeMessagingProvider)) {
    throw new Error("Rode com ADAPTER_MODE=fake");
  }
  if (!(assistant instanceof FakeSalesAssistant)) {
    throw new Error("Rode com ADAPTER_MODE=fake (assistente)");
  }

  console.log("0) Limpa artefatos de execuções anteriores do demo…");
  await db.execute(
    sql`delete from wa_messages where conversation_id in
        (select id from wa_conversations where phone_e164 = ${CLIENT_PHONE_E164})`,
  );
  // Qualquer wa.bot_turn não concluído é sobra de execução anterior do demo:
  // se ficar, o retry consome os roteiros do assistente fake fora de ordem.
  await db.execute(
    sql`delete from outbox_events where event_type = 'wa.bot_turn' and status <> 'done'`,
  );
  await db.execute(
    sql`delete from wa_conversations where phone_e164 = ${CLIENT_PHONE_E164}`,
  );

  console.log("   Liga WhatsApp + bot e cadastra o número do dono…");
  for (const [key, value] of [
    ["wa_enabled", "true"],
    ["bot_enabled", "true"],
    ["owner_whatsapp_phone", JSON.stringify(OWNER_PHONE)],
  ] as const) {
    await db.execute(
      sql`insert into settings (key, value) values (${key}, ${value}::jsonb)
          on conflict (key) do update set value = excluded.value`,
    );
  }

  const products = await listPublicProducts(db, {});
  const detailed = await Promise.all(
    products.map((product) => getPublicProductBySlug(db, product.slug)),
  );
  const withStock = detailed
    .flatMap((product) => (product ? [product] : []))
    .map((product) => ({
      product,
      variant: product.variants.find((variant) => variant.availableQty > 0),
    }))
    .find((entry) => entry.variant);
  if (!withStock?.variant) {
    throw new Error("Nenhum produto com estoque no banco — rode o seed antes.");
  }
  const { product, variant } = withStock;
  console.log(`   produto do roteiro: ${product.name} (SKU ${variant.sku})`);

  console.log('1) Cliente: "Oi, o que vocês vendem?" → robô lista o catálogo…');
  assistant.enqueueScript({
    toolCalls: [{ name: "listar_produtos", input: {} }],
    replyTemplate: (toolTexts) =>
      `Olá! Que bom te ver por aqui 😊 Esses são os nossos produtos:\n\n${toolTexts[0]}`,
  });
  await processZapiInbound(db, inboundText("Oi, o que vocês vendem?"));
  await drainAll(db);
  console.log(`   robô respondeu: ${lastClientMessage(wa).slice(0, 120)}…`);

  console.log(`2) Cliente pergunta do produto → robô detalha com preço real…`);
  assistant.enqueueScript({
    toolCalls: [{ name: "detalhar_produto", input: { produto: product.name } }],
    replyTemplate: (toolTexts) => toolTexts[0],
  });
  await processZapiInbound(db, inboundText(`Me conta mais sobre ${product.name}`));
  await drainAll(db);
  console.log(`   robô respondeu: ${lastClientMessage(wa).slice(0, 120)}…`);

  console.log("3) Cliente pede o frete para 01310-100…");
  assistant.enqueueScript({
    toolCalls: [{ name: "cotar_frete", input: { cep: "01310-100" } }],
    replyTemplate: (toolTexts) => toolTexts[0],
  });
  await processZapiInbound(db, inboundText("Quanto fica o frete pro CEP 01310-100?"));
  await drainAll(db);
  console.log(`   robô respondeu: ${lastClientMessage(wa).slice(0, 120)}…`);

  console.log("4) Cliente fecha a compra → robô CRIA o pedido com link…");
  assistant.enqueueScript({
    toolCalls: [
      {
        name: "criar_pedido",
        input: {
          itens: [{ sku: variant.sku, quantidade: 1 }],
          nome_completo: "Cliente do Demo Bot",
          cpf: "90548163766",
          cep: "01310-100",
          rua: "Avenida Paulista",
          numero: "1000",
          bairro: "Bela Vista",
          cidade: "São Paulo",
          uf: "SP",
        },
      },
    ],
    replyTemplate: (toolTexts) => toolTexts[0],
  });
  await processZapiInbound(
    db,
    inboundText("Fechado! Meus dados: Cliente do Demo Bot, CPF 905.481.637-66…"),
  );
  await drainAll(db);
  const orderSummary = lastClientMessage(wa);
  console.log(`   resumo enviado ao cliente:\n---\n${orderSummary}\n---`);

  const [order] = await db
    .select()
    .from(schema.orders)
    .orderBy(desc(schema.orders.createdAt))
    .limit(1);
  if (order.channel !== "whatsapp") {
    throw new Error(`Esperava canal whatsapp, veio ${order.channel}`);
  }
  if (!orderSummary.includes(String(order.orderNumber))) {
    throw new Error("O resumo enviado não menciona o número do pedido");
  }
  console.log(
    `   ✓ pedido #${order.orderNumber} criado (canal ${order.channel}, status ${order.status})`,
  );

  const [conversation] = await db
    .select()
    .from(schema.waConversations)
    .where(eq(schema.waConversations.phoneE164, CLIENT_PHONE_E164));
  if (!conversation.customerId) {
    throw new Error("Conversa não foi vinculada ao cliente do pedido");
  }
  console.log("   ✓ conversa vinculada ao cliente no painel");

  console.log('5) Cliente: "quero falar com um atendente" → transfere…');
  assistant.enqueueScript({
    toolCalls: [
      {
        name: "transferir_para_atendente",
        input: { motivo: "Cliente pediu atendimento humano" },
      },
    ],
    replyTemplate: "não usado — endsTurn corta antes da resposta final",
  });
  await processZapiInbound(db, inboundText("Quero falar com um atendente, por favor"));
  // Duas varreduras: a 1ª roda o turno (que ENFILEIRA o aviso ao dono), a 2ª
  // entrega o aviso — em produção o cron/kick do Inngest faz esse papel.
  await drainAll(db);
  await drainAll(db);

  const [afterHandoff] = await db
    .select()
    .from(schema.waConversations)
    .where(eq(schema.waConversations.id, conversation.id));
  if (afterHandoff.status !== "human") {
    throw new Error(`Esperava conversa 'human', veio '${afterHandoff.status}'`);
  }
  const ownerAlert = [...wa.sentMessages]
    .reverse()
    .find((sent) => sent.toE164 === OWNER_PHONE && sent.body.includes("🤖→👤"));
  if (!ownerAlert) throw new Error("Dono não recebeu o aviso da transferência");
  console.log(`   ✓ conversa com o dono agora; aviso interno: "${ownerAlert.body}"`);

  console.log(
    `\nDemo OK ✅ — ${wa.sentMessages.length} mensagens simuladas; pedido #${order.orderNumber} aguardando pagamento com link no resumo acima.`,
  );
  console.log(
    "Veja no admin: /admin/whatsapp/conversas (thread completa) e /admin/pedidos.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Demo falhou:", error);
    process.exit(1);
  });
