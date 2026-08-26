import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cx } from "@/components/ui/cx";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { requireUser } from "@/services/auth";
import {
  getWaConversationThread,
  type WaThreadMessage,
} from "@/services/wa-conversations";
import { attendantBadge, maskPhone, MESSAGE_STATUS_BADGE } from "../format";
import { ManualReplyForm, ReturnToBotForm, TakeOverForm } from "./thread-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Conversa do WhatsApp",
};

function MessageBubble({ message }: { message: WaThreadMessage }) {
  const outbound = message.direction === "outbound";
  const status = MESSAGE_STATUS_BADGE[message.status] ?? null;

  return (
    <div className={cx("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cx(
          "max-w-[85%] rounded-lg px-3 py-2 sm:max-w-[70%]",
          outbound
            ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100"
            : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
        )}
      >
        <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
        <p
          className={cx(
            "mt-1 flex flex-wrap items-center gap-1.5 text-[11px]",
            outbound
              ? "justify-end text-emerald-700 dark:text-emerald-400"
              : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          <span>{formatDateTimeSP(message.createdAt)}</span>
          {outbound && status ? <span>· {status.label}</span> : null}
        </p>
        {outbound && message.status === "failed" && message.errorDetail ? (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {message.errorDetail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default async function WaConversationThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;

  // UUID inválido na URL não deve virar erro 500 do banco.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    notFound();
  }

  const thread = await getWaConversationThread(getDb(), id);
  if (!thread) notFound();

  const { conversation, messages } = thread;
  const badge = attendantBadge(conversation.status, conversation.botDisabledUntil);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={conversation.customerName ?? maskPhone(conversation.phoneE164)}
        subtitle={
          conversation.customerName
            ? `WhatsApp ${maskPhone(conversation.phoneE164)} — conversa iniciada em ${formatDateTimeSP(conversation.createdAt)}.`
            : `Conversa iniciada em ${formatDateTimeSP(conversation.createdAt)}.`
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <Link
              href="/admin/whatsapp/conversas"
              className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              ← Todas as conversas
            </Link>
          </div>
        }
      />

      <Card title="Mensagens">
        {messages.length === 0 ? (
          <EmptyState
            title="Nenhuma mensagem nesta conversa"
            hint="As mensagens trocadas com este número aparecem aqui em ordem cronológica."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Mensagens à direita são da loja (robô ou você); à esquerda, do
          cliente. A página não atualiza sozinha — recarregue para ver as
          mensagens mais novas.
        </p>
      </Card>

      {conversation.status !== "closed" ? (
        <Card title="Atendimento">
          <div className="flex flex-col gap-5">
            {conversation.status === "human" ? (
              <ReturnToBotForm conversationId={conversation.id} />
            ) : (
              <TakeOverForm conversationId={conversation.id} />
            )}
            <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <ManualReplyForm conversationId={conversation.id} />
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
