import type { Metadata } from "next";
import Link from "next/link";

import { getAdapterMode } from "@/adapters/adapter-mode";
import { getMessagingProvider } from "@/adapters/zapi";
import { Badge } from "@/components/ui/badge";
import { Card, StatCard } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { formatCentsBRL } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import { getSettingsMap } from "@/services/settings";
import { countConversationsAwaitingOwner } from "@/services/wa-conversations";
import {
  getBotActivitySummary,
  listRecentBotActivity,
  type BotActivityEvent,
  type BotActivitySummary,
} from "@/services/wa-insights";
import { siteBaseUrl } from "@/services/wa-messaging";
import {
  getWaSessionOverview,
  type WaSessionOverview,
} from "@/services/wa-session";
import {
  isOwnerTemplate,
  listWaTemplates,
  type WaTemplate,
} from "@/services/wa-templates";
import { maskPhone } from "./conversas/format";
import {
  BotSettingsForm,
  SendTestMessageForm,
  TemplateEditForm,
  ToggleSwitch,
  WaSettingsForm,
} from "./forms";
import { QrAutoRefresh } from "./qr-auto-refresh";
import { Rehearsal } from "./rehearsal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vendedora & WhatsApp",
};

// ---------------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------------

interface PageData {
  overview: WaSessionOverview | null;
  waEnabledSetting: boolean;
  ownerPhone: string;
  recoveryAfterMinutes: number;
  botEnabledSetting: boolean;
  botModel: string;
  sellerName: string;
  exchangePolicy: string;
  botExtraInstructions: string;
  quickReplies: string;
  templates: WaTemplate[];
  summary: BotActivitySummary;
  activity: BotActivityEvent[];
  awaitingOwner: number;
}

async function loadPageData(): Promise<PageData | null> {
  const db = getDb();

  let settingsMap: Record<string, unknown>;
  let templates: WaTemplate[];
  let summary: BotActivitySummary;
  let activity: BotActivityEvent[];
  let awaitingOwner: number;
  try {
    [settingsMap, templates, summary, activity, awaitingOwner] = await Promise.all([
      getSettingsMap(db, [
        "wa_enabled",
        "owner_whatsapp_phone",
        "wa_recovery_after_minutes",
        "bot_enabled",
        "bot_model",
        "bot_seller_name",
        "store_exchange_policy",
        "bot_extra_instructions",
        "wa_quick_replies",
      ]),
      listWaTemplates(db),
      getBotActivitySummary(db),
      listRecentBotActivity(db, { limit: 8 }),
      countConversationsAwaitingOwner(db),
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

  const text = (key: string): string =>
    typeof settingsMap[key] === "string" ? (settingsMap[key] as string) : "";
  const rawMinutes = settingsMap["wa_recovery_after_minutes"];
  return {
    overview,
    waEnabledSetting: settingsMap["wa_enabled"] === true,
    ownerPhone: text("owner_whatsapp_phone"),
    recoveryAfterMinutes:
      typeof rawMinutes === "number" && Number.isFinite(rawMinutes)
        ? rawMinutes
        : 60,
    botEnabledSetting: settingsMap["bot_enabled"] === true,
    botModel: text("bot_model") || "claude-sonnet-5",
    sellerName: text("bot_seller_name").trim() || DEFAULT_SELLER_NAME,
    exchangePolicy: text("store_exchange_policy"),
    botExtraInstructions: text("bot_extra_instructions"),
    quickReplies: text("wa_quick_replies"),
    templates,
    summary,
    activity,
    awaitingOwner,
  };
}

function usdCents(cents: number): string {
  return `US$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default async function WhatsappPage() {
  await requireOwner("whatsapp");
  const data = await loadPageData();

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Vendedora & WhatsApp"
          subtitle="A vendedora virtual, a conexão com o WhatsApp da loja e as mensagens automáticas."
        />
        <EmptyState
          title="Não foi possível carregar as informações do WhatsApp"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  const {
    overview,
    waEnabledSetting,
    ownerPhone,
    recoveryAfterMinutes,
    botEnabledSetting,
    botModel,
    sellerName,
    exchangePolicy,
    botExtraInstructions,
    quickReplies,
    templates,
    summary,
    activity,
    awaitingOwner,
  } = data;

  // O interruptor sozinho não liga a vendedora em produção: sem a chave da
  // Anthropic na hospedagem, o inbound segue para o dono (isBotEnabled).
  const anthropicKeyMissing =
    getAdapterMode() !== "fake" &&
    !(process.env.ANTHROPIC_API_KEY ?? "").trim();
  const connected = overview?.connected === true;
  const sellerLive =
    botEnabledSetting && waEnabledSetting && !anthropicKeyMissing && connected;

  const siteUrl = siteBaseUrl();
  const webhookSecret = process.env.ZAPI_WEBHOOK_SECRET?.trim() || null;
  const webhookUrl = webhookSecret
    ? `${siteUrl}/api/webhooks/zapi/${webhookSecret}`
    : `${siteUrl}/api/webhooks/zapi/<ZAPI_WEBHOOK_SECRET>`;

  const customerTemplates = templates.filter((template) => !isOwnerTemplate(template.key));
  const ownerTemplates = templates.filter((template) => isOwnerTemplate(template.key));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Vendedora & WhatsApp"
        subtitle={`A ${sellerName} atende as clientes no WhatsApp da loja; aqui você liga, ajusta o jeito dela e acompanha o que ela fez.`}
        actions={
          <Link
            href="/admin/whatsapp/conversas"
            className="inline-flex items-center justify-center rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-ivory-50 transition-colors hover:bg-ink-800 dark:bg-ivory-100 dark:text-ink-900 dark:hover:bg-ivory-200"
          >
            Abrir conversas
          </Link>
        }
      />

      {/* Faixa de status */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="WhatsApp da loja"
          value={
            !waEnabledSetting
              ? "Desligado"
              : overview === null
                ? "Sem resposta"
                : connected
                  ? "Conectado"
                  : "Desconectado"
          }
          tone={!waEnabledSetting ? "neutral" : connected ? "success" : "danger"}
          hint={
            overview && overview.queuedCount > 0
              ? `${overview.queuedCount} ${overview.queuedCount === 1 ? "mensagem" : "mensagens"} na fila`
              : "Fila vazia"
          }
        />
        <StatCard
          label={`Vendedora ${sellerName}`}
          value={sellerLive ? "Atendendo" : botEnabledSetting ? "Ligada, parada" : "Desligada"}
          tone={sellerLive ? "success" : botEnabledSetting ? "warning" : "neutral"}
          hint={
            sellerLive
              ? `${summary.conversationsToday} ${summary.conversationsToday === 1 ? "conversa" : "conversas"} hoje`
              : botEnabledSetting
                ? anthropicKeyMissing
                  ? "falta a chave da Anthropic"
                  : !waEnabledSetting
                    ? "o WhatsApp está desligado"
                    : "o WhatsApp está desconectado"
                : "as mensagens caem com você"
          }
        />
        <StatCard
          label="Aguardando você"
          value={awaitingOwner}
          tone={awaitingOwner > 0 ? "warning" : "neutral"}
          hint={awaitingOwner > 0 ? "conversas com mensagem nova" : "nenhuma pendente"}
        />
        <StatCard
          label={`Pedidos da ${sellerName}`}
          value={summary.ordersByBot}
          tone={summary.ordersByBot > 0 ? "success" : "neutral"}
          hint={`${formatCentsBRL(summary.ordersByBotCents)} em ${summary.windowDays} dias`}
        />
      </div>

      {/* Interruptores */}
      <Card title="Ligar e desligar">
        <div className="grid gap-6 md:grid-cols-2">
          <ToggleSwitch
            settingKey="wa_enabled"
            checked={waEnabledSetting}
            label="WhatsApp automático da loja"
            hint="Avisos de pedido, lembrete de pagamento e a vendedora. Desligado, nada sai pelo WhatsApp."
          />
          <ToggleSwitch
            settingKey="bot_enabled"
            checked={botEnabledSetting}
            label={`Deixar a ${sellerName} vender sozinha`}
            hint="Ligada, ela apresenta as peças, cota o frete, monta o pedido e manda o link de pagamento. Desligada, as mensagens das clientes chegam para você."
          />
        </div>
        {botEnabledSetting && anthropicKeyMissing ? (
          <div className="mt-4">
            <Warning>
              A vendedora está ligada, mas a chave da inteligência (Anthropic)
              ainda não foi configurada na hospedagem — por segurança ela fica
              parada e as mensagens seguem para o seu WhatsApp, como sempre.
            </Warning>
          </div>
        ) : null}
      </Card>

      {/* A vendedora */}
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card title={`A ficha da ${sellerName}`}>
          <BotSettingsForm
            sellerName={sellerName}
            botModel={botModel}
            exchangePolicy={exchangePolicy}
            botExtraInstructions={botExtraInstructions}
            quickReplies={quickReplies}
          />
        </Card>
        <div className="flex flex-col gap-6">
          <Card title={`Testar a ${sellerName}`}>
            <Rehearsal sellerName={sellerName} />
          </Card>
          <Card title={`O que a ${sellerName} fez em ${summary.windowDays} dias`}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-zinc-500 dark:text-zinc-400">Respostas</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{summary.turns}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 dark:text-zinc-400">Passou para você</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{summary.handoffs}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 dark:text-zinc-400">Pedidos fechados</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  {summary.ordersByBot}
                  <span className="ml-1 text-xs font-normal text-zinc-500">{formatCentsBRL(summary.ordersByBotCents)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 dark:text-zinc-400">Custo estimado da IA</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{usdCents(summary.estimatedCostUsdCents)}</dd>
              </div>
            </dl>
            {activity.length === 0 ? (
              <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
                Quando ela fechar um pedido ou passar uma conversa para você, aparece aqui.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                {activity.map((event, index) => (
                  <li key={`${event.kind}-${index}`} className="flex items-start gap-3 py-2 text-sm">
                    <span
                      aria-hidden="true"
                      className={
                        event.kind === "order"
                          ? "mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                          : "mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-500"
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {event.kind === "order" ? (
                            <Link href={`/admin/pedidos/${event.orderId}`} className="hover:underline">
                              {event.title}
                            </Link>
                          ) : event.conversationId ? (
                            <Link
                              href={`/admin/whatsapp/conversas?c=${event.conversationId}`}
                              className="hover:underline"
                            >
                              Passou para você: {event.title}
                            </Link>
                          ) : (
                            event.title
                          )}
                        </span>
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          {formatDateTimeSP(event.at)}
                        </span>
                      </span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {event.who ?? (event.phoneE164 ? maskPhone(event.phoneE164) : "cliente")}
                        {event.detail ? ` — ${event.detail}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {/* Conexão */}
      <Card title="Conexão com o WhatsApp da loja">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {!waEnabledSetting ? (
              <Badge tone="neutral">Desligado</Badge>
            ) : overview ? (
              connected ? (
                <Badge tone="success">Conectado</Badge>
              ) : (
                <Badge tone="danger">Desconectado</Badge>
              )
            ) : (
              <Badge tone="warning">Estado indisponível</Badge>
            )}
            {overview && overview.queuedCount > 0 ? (
              <Badge tone="warning">
                {overview.queuedCount === 1
                  ? "1 mensagem aguardando envio"
                  : `${overview.queuedCount} mensagens aguardando envio`}
              </Badge>
            ) : null}
            <div className="ml-auto">
              <SendTestMessageForm />
            </div>
          </div>

          {!overview && waEnabledSetting ? (
            <Warning>
              Não conseguimos consultar o estado da conexão agora. As mensagens
              continuam acumulando na fila e nada se perde — recarregue em
              instantes.
            </Warning>
          ) : null}

          {overview && !connected && waEnabledSetting ? (
            <QrAutoRefresh>
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
                </p>
              </div>
            </QrAutoRefresh>
          ) : null}

          <WaSettingsForm
            ownerPhone={ownerPhone}
            recoveryAfterMinutes={recoveryAfterMinutes}
          />

          <details className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Configuração técnica (Z-API)
            </summary>
            <div className="flex flex-col gap-3 border-t border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              <p>
                No painel da Z-API, cadastre esta URL no webhook{" "}
                <strong>“ao receber”</strong> para que as mensagens das clientes
                e as confirmações de entrega cheguem à loja:
              </p>
              <CopyField label="URL do webhook" value={webhookUrl} />
              {!webhookSecret ? (
                <Warning>
                  A variável ZAPI_WEBHOOK_SECRET ainda não está configurada na
                  hospedagem — defina-a primeiro e substitua o trecho
                  &lt;ZAPI_WEBHOOK_SECRET&gt; da URL acima pelo valor escolhido.
                </Warning>
              ) : null}
            </div>
          </details>
        </div>
      </Card>

      {/* Mensagens automáticas */}
      <Card title="Mensagens automáticas">
        <div className="flex flex-col gap-6">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Cada uma dispara num momento do pedido. Mantenha o tom curto e útil —
            mensagem promocional em massa pode levar ao bloqueio do número.
          </p>
          {templates.length === 0 ? (
            <EmptyState
              title="Nenhum modelo de mensagem encontrado"
              hint="Os modelos padrão são criados na instalação da loja (seed). Fale com o suporte técnico."
            />
          ) : (
            <>
              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Para a cliente
                </h3>
                {customerTemplates.map((template) => (
                  <TemplateEditForm
                    key={template.key}
                    templateKey={template.key}
                    label={template.label}
                    bodyTemplate={template.bodyTemplate}
                    isActive={template.isActive}
                  />
                ))}
              </section>
              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Para você
                </h3>
                {ownerTemplates.map((template) => (
                  <TemplateEditForm
                    key={template.key}
                    templateKey={template.key}
                    label={template.label}
                    bodyTemplate={template.bodyTemplate}
                    isActive={template.isActive}
                  />
                ))}
              </section>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
