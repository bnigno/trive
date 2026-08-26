import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { requireUser } from "@/services/auth";
import {
  listWaConversations,
  type WaConversationListItem,
} from "@/services/wa-conversations";
import { attendantBadge, maskPhone } from "./format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Conversas do WhatsApp",
};

function preview(item: WaConversationListItem): string {
  if (!item.lastMessagePreview) return "—";
  const body = item.lastMessagePreview;
  return body.length > 70 ? `${body.slice(0, 70)}…` : body;
}

export default async function WaConversationsPage() {
  await requireUser();

  let conversations: WaConversationListItem[] | null = null;
  try {
    conversations = await listWaConversations(getDb());
  } catch {
    conversations = null;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Conversas do WhatsApp"
        subtitle="Acompanhe o robô vendendo em tempo real. Abra uma conversa para ler a troca completa, assumir o atendimento ou responder na mão."
        actions={
          <Link
            href="/admin/whatsapp"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ← Configurações do WhatsApp
          </Link>
        }
      />

      <Card title="Conversas recentes">
        {conversations === null ? (
          <EmptyState
            title="Não foi possível carregar as conversas"
            hint="O banco de dados está indisponível no momento. Tente recarregar a página."
          />
        ) : conversations.length === 0 ? (
          <EmptyState
            title="Nenhuma conversa ainda"
            hint="Quando um cliente mandar mensagem para o WhatsApp da loja, a conversa aparece aqui — com o robô respondendo, se estiver ligado."
          />
        ) : (
          <Table
            headers={["Última atividade", "Telefone", "Cliente", "Atendimento", "Última mensagem"]}
          >
            {conversations.map((item) => {
              const badge = attendantBadge(item.status, item.botDisabledUntil);
              return (
                <Tr key={item.id}>
                  <Td className="whitespace-nowrap">
                    <Link
                      href={`/admin/whatsapp/conversas/${item.id}`}
                      className="text-emerald-700 hover:underline dark:text-emerald-400"
                    >
                      {item.lastMessageAt
                        ? formatDateTimeSP(item.lastMessageAt)
                        : "—"}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {maskPhone(item.phoneE164)}
                  </Td>
                  <Td>{item.customerName ?? "—"}</Td>
                  <Td>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </Td>
                  <Td className="max-w-sm truncate">
                    {item.lastMessageDirection === "inbound" ? "↓ " : ""}
                    {item.lastMessageDirection === "outbound" ? "↑ " : ""}
                    {preview(item)}
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          <strong>Robô ativo</strong> = a IA responde sozinha;{" "}
          <strong>Com você</strong> = você assumiu (ou o robô transferiu) e as
          respostas dos clientes chegam no seu WhatsApp;{" "}
          <strong>Robô em pausa</strong> = transferência recente, o robô volta
          sozinho depois do prazo ou quando você devolver a conversa.
        </p>
      </Card>
    </div>
  );
}
