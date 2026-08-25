import type { Metadata } from "next";
import Link from "next/link";

import { getMessagingProvider } from "@/adapters/zapi";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import type { BadgeTone } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { requireUser } from "@/services/auth";
import { getSettingsMap } from "@/services/settings";
import { siteBaseUrl } from "@/services/wa-messaging";
import {
  getWaSessionOverview,
  type WaSessionOverview,
} from "@/services/wa-session";
import { listWaTemplates, type WaTemplate } from "@/services/wa-templates";
import {
  SendTestMessageForm,
  TemplateEditForm,
  WaSettingsForm,
} from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "WhatsApp",
};

// ---------------------------------------------------------------------------
// Formatação (server-side)
// ---------------------------------------------------------------------------

/** '+5511999991234' -> '(11) •••••-1234' — nunca expõe o número inteiro. */
function maskPhone(phoneE164: string): string {
  const last4 = phoneE164.slice(-4);
  if (phoneE164.startsWith("+55") && phoneE164.length >= 12) {
    const ddd = phoneE164.slice(3, 5);
    return `(${ddd}) •••••-${last4}`;
  }
  return `•••• ${last4}`;
}

const MESSAGE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  queued: { label: "Na fila", tone: "warning" },
  sent: { label: "Enviada", tone: "info" },
  delivered: { label: "Entregue", tone: "success" },
  read: { label: "Lida", tone: "success" },
  failed: { label: "Falhou", tone: "danger" },
};

function messagePreview(templateKey: string | null, body: string): string {
  if (templateKey) return templateKey;
  return body.length > 60 ? `${body.slice(0, 60)}…` : body;
}

// ---------------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------------

interface PageData {
  overview: WaSessionOverview | null;
  waEnabledSetting: boolean;
  ownerPhone: string;
  recoveryAfterMinutes: number;
  templates: WaTemplate[];
}

async function loadPageData(): Promise<PageData | null> {
  const db = getDb();

  let settingsMap: Record<string, unknown>;
  let templates: WaTemplate[];
  try {
    [settingsMap, templates] = await Promise.all([
      getSettingsMap(db, [
        "wa_enabled",
        "owner_whatsapp_phone",
        "wa_recovery_after_minutes",
      ]),
      listWaTemplates(db),
    ]);
  } catch {
    return null;
  }

  // Estado da sessão à parte: o provedor (Z-API) pode estar fora do ar sem
  // que a página inteira precise cair.
  let overview: WaSessionOverview | null = null;
  try {
    overview = await getWaSessionOverview(db, getMessagingProvider());
  } catch {
    overview = null;
  }

  const rawMinutes = settingsMap["wa_recovery_after_minutes"];
  return {
    overview,
    waEnabledSetting: settingsMap["wa_enabled"] === true,
    ownerPhone:
      typeof settingsMap["owner_whatsapp_phone"] === "string"
        ? (settingsMap["owner_whatsapp_phone"] as string)
        : "",
    recoveryAfterMinutes:
      typeof rawMinutes === "number" && Number.isFinite(rawMinutes)
        ? rawMinutes
        : 60,
    templates,
  };
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default async function WhatsappPage() {
  await requireUser();
  const data = await loadPageData();

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="WhatsApp"
          subtitle="Mensagens automáticas para clientes e avisos internos — tudo passa pela fila: nada se perde se a conexão cair."
        />
        <EmptyState
          title="Não foi possível carregar as informações do WhatsApp"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  const { overview, waEnabledSetting, ownerPhone, recoveryAfterMinutes, templates } =
    data;

  const siteUrl = siteBaseUrl();
  const webhookSecret = process.env.ZAPI_WEBHOOK_SECRET?.trim() || null;
  const webhookUrl = webhookSecret
    ? `${siteUrl}/api/webhooks/zapi/${webhookSecret}`
    : `${siteUrl}/api/webhooks/zapi/<ZAPI_WEBHOOK_SECRET>`;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="WhatsApp"
        subtitle="Mensagens automáticas para clientes e avisos internos — tudo passa pela fila: nada se perde se a conexão cair."
      />

      <Card title="Status da conexão">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {waEnabledSetting ? (
              <Badge tone="success">Ativado</Badge>
            ) : (
              <Badge tone="neutral">Desativado</Badge>
            )}
            {overview ? (
              overview.connected ? (
                <Badge tone="success">Conectado</Badge>
              ) : (
                <Badge tone="danger">Desconectado</Badge>
              )
            ) : (
              <Badge tone="warning">Estado indisponível</Badge>
            )}
            <Link
              href="/admin/whatsapp"
              className="ml-auto inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Atualizar
            </Link>
          </div>

          {!overview ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Não conseguimos consultar o estado da conexão agora. As mensagens
              continuam acumulando na fila e nada se perde — tente atualizar em
              instantes.
            </p>
          ) : null}

          {overview && !overview.connected && waEnabledSetting ? (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              {overview.qrImageBase64 ? (
                 
                <img
                  src={`data:image/png;base64,${overview.qrImageBase64}`}
                  alt="QR code para conectar o WhatsApp da loja"
                  className="h-48 w-48 rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700"
                />
              ) : null}
              <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
                Para conectar: abra o WhatsApp no celular do número da loja →{" "}
                <strong>Aparelhos conectados</strong> →{" "}
                <strong>Conectar aparelho</strong> → escaneie o código ao lado.
                Depois clique em “Atualizar”.
              </p>
            </div>
          ) : null}

          {overview && overview.queuedCount > 0 ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {overview.queuedCount === 1
                ? "1 mensagem aguardando envio"
                : `${overview.queuedCount} mensagens aguardando envio`}{" "}
              — elas serão entregues automaticamente assim que a conexão
              voltar. Nenhuma se perde.
            </p>
          ) : null}
        </div>
      </Card>

      <Card title="Configuração">
        <div className="flex flex-col gap-6">
          <WaSettingsForm
            waEnabled={waEnabledSetting}
            ownerPhone={ownerPhone}
            recoveryAfterMinutes={recoveryAfterMinutes}
          />
          <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
              Quer conferir se está tudo funcionando? Envie um teste para o seu
              próprio número cadastrado acima.
            </p>
            <SendTestMessageForm />
          </div>
        </div>
      </Card>

      <Card title="Mensagens automáticas">
        <div className="flex flex-col gap-4">
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Mantenha o tom transacional e curto — mensagens promocionais em
            massa podem levar ao banimento do número pelo WhatsApp.
          </p>
          {templates.length === 0 ? (
            <EmptyState
              title="Nenhum modelo de mensagem encontrado"
              hint="Os modelos padrão são criados na instalação da loja (seed). Fale com o suporte técnico."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {templates.map((template) => (
                <TemplateEditForm
                  key={template.key}
                  templateKey={template.key}
                  label={template.label}
                  bodyTemplate={template.bodyTemplate}
                  isActive={template.isActive}
                  isInternal={template.key.startsWith("owner_")}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card title="Últimas mensagens">
        {!overview || overview.lastMessages.length === 0 ? (
          <EmptyState
            title="Nenhuma mensagem por aqui ainda"
            hint="Quando a loja enviar avisos ou um cliente responder, o histórico recente aparece nesta lista."
          />
        ) : (
          <Table headers={["Quando", "Telefone", "", "Status", "Mensagem"]}>
            {overview.lastMessages.map((message) => {
              const status = MESSAGE_STATUS[message.status] ?? {
                label: message.status,
                tone: "neutral" as BadgeTone,
              };
              return (
                <Tr key={message.id}>
                  <Td className="whitespace-nowrap">
                    {formatDateTimeSP(message.createdAt)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {maskPhone(message.phoneE164)}
                  </Td>
                  <Td
                    className="text-center"
                    aria-label={
                      message.direction === "outbound"
                        ? "Enviada pela loja"
                        : "Recebida do cliente"
                    }
                  >
                    <span
                      title={
                        message.direction === "outbound"
                          ? "Enviada pela loja"
                          : "Recebida do cliente"
                      }
                    >
                      {message.direction === "outbound" ? "↑" : "↓"}
                    </span>
                  </Td>
                  <Td>
                    <StatusPill label={status.label} tone={status.tone} />
                  </Td>
                  <Td className="max-w-xs truncate">
                    {messagePreview(message.templateKey, message.body)}
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
      </Card>

      <details className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Configuração avançada — painel Z-API
        </summary>
        <div className="flex flex-col gap-3 border-t border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          <p>
            No painel da Z-API, cadastre esta URL no webhook{" "}
            <strong>“ao receber”</strong> para que as respostas dos clientes e
            as confirmações de entrega cheguem à loja:
          </p>
          <code className="block overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
            {webhookUrl}
          </code>
          {!webhookSecret ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              A variável ZAPI_WEBHOOK_SECRET ainda não está configurada na
              hospedagem — defina-a primeiro e substitua o trecho
              &lt;ZAPI_WEBHOOK_SECRET&gt; da URL acima pelo valor escolhido.
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}
