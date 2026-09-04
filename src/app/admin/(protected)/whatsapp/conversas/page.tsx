import type { Metadata } from "next";

import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { getSettingsMap } from "@/services/settings";
import { isBotEnabled } from "@/services/wa-bot";
import {
  getWaThreadTail,
  listWaConversations,
} from "@/services/wa-conversations";
import { ChatShell } from "./chat-shell";
import type { ChatConversation, ChatThread } from "./use-chat-poll";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Conversas do WhatsApp",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A página semeia a mesma cauda que o poll entrega (últimas 100 mensagens),
// no mesmo formato JSON — um único caminho de dados para o chat.
const INITIAL_TAIL = 100;

// Datas viram ISO na fronteira RSC→client: mesmo formato do poll (JSON).
const iso = (date: Date | null): string | null =>
  date ? date.toISOString() : null;

/** Respostas rápidas do composer: setting (uma por linha) ou as da casa. */
const DEFAULT_QUICK_REPLIES = [
  "Oi! Aqui é a equipe da TRIVÉ 🤎 Já estou com a sua conversa.",
  "Um instante, estou conferindo aqui e já te respondo.",
  "Seu pedido saiu para entrega! Qualquer coisa, é só chamar.",
  "Obrigada pelo carinho 🤎 Foi um prazer te atender.",
];

export default async function WaConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  await requireUser();
  const { c } = await searchParams;
  const selectedId = c && UUID_RE.test(c) ? c : null;

  let conversations: ChatConversation[] = [];
  let thread: ChatThread | null = null;
  let threadMeta: { phoneE164: string; customerName: string | null } | null =
    null;
  let botEnabled = false;
  let sellerName = DEFAULT_SELLER_NAME;
  let quickReplies = DEFAULT_QUICK_REPLIES;
  try {
    const db = getDb();
    const [rows, enabled, settings] = await Promise.all([
      listWaConversations(db),
      isBotEnabled(db),
      getSettingsMap(db, ["bot_seller_name", "wa_quick_replies"]),
    ]);
    botEnabled = enabled;
    if (
      typeof settings["bot_seller_name"] === "string" &&
      (settings["bot_seller_name"] as string).trim() !== ""
    ) {
      sellerName = (settings["bot_seller_name"] as string).trim();
    }
    if (typeof settings["wa_quick_replies"] === "string") {
      const lines = (settings["wa_quick_replies"] as string)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (lines.length > 0) quickReplies = lines;
    }
    conversations = rows.map((row) => ({
      ...row,
      botDisabledUntil: iso(row.botDisabledUntil),
      lastMessageAt: iso(row.lastMessageAt),
    }));
    if (selectedId) {
      const tail = await getWaThreadTail(db, {
        conversationId: selectedId,
        limit: INITIAL_TAIL,
      });
      const listed = rows.find((row) => row.id === selectedId);
      if (tail && listed) {
        threadMeta = {
          phoneE164: listed.phoneE164,
          customerName: listed.customerName,
        };
        thread = {
          conversation: {
            id: tail.conversation.id,
            status: tail.conversation.status,
            botDisabledUntil: iso(tail.conversation.botDisabledUntil),
            ownerLastSeenAt: null,
          },
          messages: tail.messages.map((message) => ({
            id: message.id,
            direction: message.direction,
            origin: message.origin,
            kind: message.kind,
            body: message.body,
            mediaUrl: message.mediaUrl,
            status: message.status,
            errorDetail: message.errorDetail,
            createdAt: message.createdAt.toISOString(),
          })),
          context: {
            ...tail.context,
            handoff: tail.context.handoff
              ? { ...tail.context.handoff, at: tail.context.handoff.at.toISOString() }
              : null,
            recentOrders: tail.context.recentOrders.map((order) => ({
              ...order,
              createdAt: order.createdAt.toISOString(),
            })),
          },
          activity: tail.activity.map((turn) => ({
            ...turn,
            createdAt: turn.createdAt.toISOString(),
          })),
        };
      }
    }
  } catch {
    // Banco indisponível: a casca renderiza vazia e o poll repovoa a tela
    // quando a conexão voltar.
    conversations = [];
    thread = null;
    threadMeta = null;
  }

  return (
    // -m-4 md:-m-8 cancela o padding do <main> do layout admin (layout.tsx); no
    // celular a barra superior (3.5rem) fica fora da altura do chat para o chat
    // ocupar a janela inteira, sem scroll da página. Mudou o padding lá,
    // mude aqui junto.
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col overflow-hidden md:-m-8 md:h-dvh">
      <ChatShell
        initialConversations={conversations}
        initialThread={thread}
        initialThreadMeta={threadMeta}
        initialSelectedId={selectedId}
        initialBotEnabled={botEnabled}
        initialSellerName={sellerName}
        quickReplies={quickReplies}
      />
    </div>
  );
}
