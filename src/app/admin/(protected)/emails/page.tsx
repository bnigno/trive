import type { Metadata } from "next";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { getEmailThread, listEmailThreads } from "@/services/email-inbox";
import { InboxShell } from "./inbox-shell";
import { toInboxMessage, toInboxThreadItem } from "./serialize";
import type { InboxBox, InboxThread, InboxThreadItem } from "./use-inbox-poll";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Caixa de e-mail",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; ver?: string }>;
}) {
  await requireUser();
  const { c, ver } = await searchParams;
  // Conversa escolhida vive na URL; qualquer coisa que não seja UUID é lixo
  // digitado e vira "nenhuma conversa aberta", nunca uma consulta.
  const selectedId = c && UUID_RE.test(c) ? c : null;
  const box: InboxBox = ver === "arquivadas" ? "archived" : "open";

  let threads: InboxThreadItem[] = [];
  let thread: InboxThread | null = null;
  let threadItem: InboxThreadItem | null = null;
  try {
    const db = getDb();
    threads = (await listEmailThreads(db, { status: box })).map(
      toInboxThreadItem,
    );
    if (selectedId) {
      const detail = await getEmailThread(db, selectedId);
      if (detail) {
        const last = detail.messages[detail.messages.length - 1] ?? null;
        threadItem = {
          id: detail.thread.id,
          subject: detail.thread.subject,
          participantEmail: detail.thread.participantEmail,
          participantName: detail.thread.participantName,
          customerName: detail.thread.customerName,
          status: detail.thread.status,
          lastMessageAt: last ? last.createdAt.toISOString() : null,
          lastMessageDirection: last?.direction ?? null,
          lastMessageSnippet: last?.snippet ?? null,
          // A tela abriu, então o dono está lendo agora: o "visto" dispara no
          // cliente e zerar aqui evita o crachá piscando por um instante.
          unreadCount: 0,
        };
        thread = {
          thread: {
            id: detail.thread.id,
            status: detail.thread.status,
            ownerLastSeenAt: detail.thread.ownerLastSeenAt
              ? detail.thread.ownerLastSeenAt.toISOString()
              : null,
          },
          messages: detail.messages.map(toInboxMessage),
        };
      }
    }
  } catch {
    // Banco indisponível: a casca renderiza vazia e o poll repovoa a tela
    // quando a conexão voltar.
    threads = [];
    thread = null;
    threadItem = null;
  }

  return (
    // -m-4 md:-m-8 cancela o padding do <main> do layout admin (layout.tsx); no
    // celular a barra superior (3.5rem) fica fora da altura do chat para a caixa
    // ocupar a janela inteira, sem scroll da página. Mudou o padding lá,
    // mude aqui junto.
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col overflow-hidden md:-m-8 md:h-dvh">
      <InboxShell
        initialThreads={threads}
        initialThread={thread}
        initialThreadItem={threadItem}
        initialSelectedId={selectedId}
      />
    </div>
  );
}
