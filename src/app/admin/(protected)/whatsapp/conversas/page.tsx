import type { Metadata } from "next";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import {
  getWaConversationThread,
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

// Datas viram ISO na fronteira RSC→client: mesmo formato do poll (JSON).
const iso = (date: Date | null): string | null =>
  date ? date.toISOString() : null;

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
  try {
    const db = getDb();
    const rows = await listWaConversations(db);
    conversations = rows.map((row) => ({
      ...row,
      botDisabledUntil: iso(row.botDisabledUntil),
      lastMessageAt: iso(row.lastMessageAt),
    }));
    if (selectedId) {
      const full = await getWaConversationThread(db, selectedId);
      if (full) {
        threadMeta = {
          phoneE164: full.conversation.phoneE164,
          customerName: full.conversation.customerName,
        };
        thread = {
          conversation: {
            id: full.conversation.id,
            status: full.conversation.status,
            botDisabledUntil: iso(full.conversation.botDisabledUntil),
            ownerLastSeenAt: null,
          },
          messages: full.messages.map((message) => ({
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
      />
    </div>
  );
}
