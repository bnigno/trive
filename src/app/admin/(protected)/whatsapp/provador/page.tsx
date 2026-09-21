// Provador TRIVÉ: as salas (grupos de WhatsApp da marca). Aqui a dona liga
// o Provador, registra um grupo que criou no celular como sala, vê quantas
// membras tem, pausa/retoma e entra na sala para agendar os rituais.
import type { Metadata } from "next";
import Link from "next/link";

import { getMessagingProvider } from "@/adapters/zapi";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { spDayLabel, spDayKey } from "@/lib/sp-day";
import { requireOwner } from "@/services/auth";
import { getSettingsMap } from "@/services/settings";
import { isWaEnabled } from "@/services/wa-messaging";
import { type GroupView, listGroups, listProviderGroups, loadGroupPolicy, loadWelcomeGiftSettings, provadorEntryUrl, type WelcomeGiftSettings } from "@/services/wa-groups";
import { siteBaseUrl } from "@/services/wa-messaging";

import { ToggleSwitch } from "../forms";
import { houseRulesAction, pauseGroupAction, resumeGroupAction, setGroupActiveAction, syncGroupAction } from "./actions";
import { CopyBlock, type ProviderGroupOption, RegisterGroupForm, WelcomeGiftForm } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provador",
};

type PageData = {
  groups: GroupView[];
  providerGroups: ProviderGroupOption[] | null;
  groupsEnabled: boolean;
  mentionsEnabled: boolean;
  waEnabled: boolean;
  sellerName: string;
  postsPerWeek: number;
  windowLabel: string;
  /** trivemaison.com.br/provador → wa.me da Lia; null sem o número da loja. */
  entryUrl: string | null;
  welcomeGift: WelcomeGiftSettings;
};

async function loadData(): Promise<PageData | null> {
  try {
    const db = getDb();
    const [groups, policy, waEnabled, settings, entryUrl, welcomeGift] = await Promise.all([
      listGroups(db),
      loadGroupPolicy(db),
      isWaEnabled(db),
      getSettingsMap(db, ["bot_seller_name"]),
      provadorEntryUrl(db),
      loadWelcomeGiftSettings(db),
    ]);
    let providerGroups: ProviderGroupOption[] | null = null;
    if (waEnabled) {
      try {
        providerGroups = await listProviderGroups(db, getMessagingProvider());
      } catch {
        providerGroups = null;
      }
    }
    const sellerName = typeof settings["bot_seller_name"] === "string" && settings["bot_seller_name"].trim() ? settings["bot_seller_name"] : "Lia";
    return {
      groups,
      providerGroups,
      groupsEnabled: policy.groupsEnabled,
      mentionsEnabled: policy.mentionsEnabled,
      waEnabled,
      sellerName,
      postsPerWeek: policy.cadence.postsPerWeek,
      windowLabel: `${policy.cadence.window.startHour}h às ${policy.cadence.window.endHour}h`,
      entryUrl,
      welcomeGift,
    };
  } catch {
    return null;
  }
}

function pausedLabel(group: GroupView, now: Date): string | null {
  if (!group.pausedUntil || group.pausedUntil.getTime() <= now.getTime()) return null;
  return `Pausada até ${spDayLabel(spDayKey(group.pausedUntil))}${group.pausedReason ? ` — ${group.pausedReason}` : ""}`;
}

export default async function ProvadorPage() {
  await requireOwner("whatsapp");
  const data = await loadData();
  const now = new Date();

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Provador" subtitle="As salas de WhatsApp da TRIVÉ." />
        <EmptyState title="Não foi possível carregar o Provador" hint="O banco de dados está indisponível no momento. Tente recarregar a página." />
      </div>
    );
  }

  const { groups, providerGroups, sellerName } = data;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Provador"
        subtitle={`As peças passam pelo grupo antes de ir para a vitrine: ${data.postsPerWeek} posts por semana (terça, quinta e sábado), estoque de verdade, e a venda acontece no privado com a ${sellerName}.`}
        actions={
          <Link
            href="/admin/whatsapp"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Voltar à vendedora
          </Link>
        }
      />

      <Card title="Ligar e desligar">
        <div className="grid gap-6 md:grid-cols-2">
          <ToggleSwitch
            settingKey="groups_enabled"
            checked={data.groupsEnabled}
            label="Provador ligado"
            hint={`Ligado, os posts agendados saem na hora marcada (dentro da janela de ${data.windowLabel}) e o grupo é lido: votos, reações e menções viram sinais. Desligado, nada sai e nada é lido — os posts agendados ficam como "pulados".`}
          />
          <ToggleSwitch
            settingKey="bot_group_mentions_enabled"
            checked={data.mentionsEnabled}
            label={`A ${sellerName} responde quando chamada no grupo`}
            hint={`Quando uma membra escreve @${sellerName} no grupo, ela responde em até 2 linhas com o que o catálogo diz e leva o resto para o privado. No máximo 5 respostas por hora por sala. (Chega no próximo passo do Provador; o interruptor já fica aqui.)`}
          />
        </div>
        {!data.waEnabled ? (
          <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">O WhatsApp automático da loja está desligado em Vendedora &amp; WhatsApp — sem ele o Provador não envia nem lê nada.</p>
        ) : null}
      </Card>

      <Card title={groups.length === 0 ? "Registrar a primeira sala" : "Registrar outra sala"}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Crie o grupo no celular da loja (nome sugerido: <span className="font-medium">Provador TRIVÉ</span>), com o número da loja como admin, e registre aqui. As regras da casa
            (grupo aberto, só admins mudam e adicionam) são aplicadas com um toque. Ninguém é adicionado pelo sistema: entra quem recebe o link.
          </p>
          {providerGroups === null ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {data.waEnabled ? "Não deu para listar os grupos agora (o WhatsApp da loja não respondeu). Recarregue em instantes." : "Ligue o WhatsApp automático para listar os grupos."}
            </p>
          ) : (
            <RegisterGroupForm groups={providerGroups} />
          )}
        </div>
      </Card>

      <Card title="Porta de entrada e mudança de casa">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Ninguém é adicionado ao grupo: quem toca em <span className="font-mono">{siteBaseUrl()}/provador</span> cai na {sellerName}, que pergunta o tamanho e as cores, pede o
            sim para os avisos no privado e entrega o convite. É este link que vai no story, no QR do vale de papel, no adesivo da sacola — e na mensagem para o grupo antigo.
          </p>
          <CopyField
            label="Link da porta de entrada"
            value={`${siteBaseUrl()}/provador`}
            hint={data.entryUrl ? `Abre o WhatsApp da loja com "quero entrar no Provador" já escrito.` : "Sem o número do WhatsApp da loja em Configurações, o link leva à home."}
          />
          <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <ToggleSwitch
              settingKey="provador_welcome_gift_enabled"
              checked={data.welcomeGift.enabled}
              label="Mimo de boas-vindas para quem entra pela Lia"
              hint="Um cupom pessoal de primeira compra vai junto do cartão de boas-vindas (uma vez por cliente, para sempre). É o “mimo” prometido na mensagem da mudança de casa — ligue antes de mandá-la."
            />
            <WelcomeGiftForm defaults={{ percent: data.welcomeGift.percent, days: data.welcomeGift.days }} />
          </div>
          <CopyBlock
            label="Mensagem para o grupo antigo (cole no grupo pelo seu celular)"
            value={[
              `Meninas, o grupo vai mudar de casa. O novo se chama Provador TRIVÉ: três mensagens por semana, as peças chegam lá antes da vitrine e vocês votam no que a gente repõe.`,
              ``,
              `Para entrar, fala com a ${sellerName}: ${siteBaseUrl()}/provador — ela pergunta seu tamanho e suas cores (para só te avisar do que serve) e te manda o convite.`,
              ``,
              data.welcomeGift.enabled
                ? `Este grupo fecha dia ___/___. Quem passar até lá ganha um mimo da ${sellerName} na primeira compra.`
                : `Este grupo fecha dia ___/___.`,
            ].join("\n")}
            hint={
              data.welcomeGift.enabled
                ? "Preencha a data (14 dias é um bom prazo). Mande de novo no 7º e no 12º dia; feche o grupo antigo na data."
                : "Preencha a data (14 dias é um bom prazo). Sem o mimo ligado, a mensagem não promete cupom — ligue acima se quiser prometer."
            }
          />
        </div>
      </Card>

      <Card title="Salas">
        {groups.length === 0 ? (
          <EmptyState title="Nenhuma sala ainda" hint="Registre o grupo acima. Depois, entre na sala para agendar o primeiro “Passou pelo Provador”." />
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => {
              const paused = pausedLabel(group, now);
              return (
                <div key={group.id} className={`rounded-lg border border-zinc-200 p-4 dark:border-zinc-800 ${group.isActive ? "" : "opacity-60"}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/admin/whatsapp/provador/${group.id}`} className="text-base font-semibold text-zinc-900 hover:underline dark:text-zinc-100">
                          {group.name}
                        </Link>
                        {!group.isActive ? <Badge tone="neutral">Desligada</Badge> : paused ? <Badge tone="warning">Pausada</Badge> : <Badge tone="success">Ativa</Badge>}
                        <Badge tone="neutral">{group.kind === "turma" ? "turma" : "provador"}</Badge>
                      </div>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        {group.memberCount} {group.memberCount === 1 ? "membra" : "membras"}
                        {group.lastSyncedAt ? ` · sincronizada ${spDayLabel(spDayKey(group.lastSyncedAt))}` : " · ainda não sincronizada"}
                      </p>
                      {paused ? <p className="text-sm text-amber-700 dark:text-amber-300">{paused}</p> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/admin/whatsapp/provador/${group.id}`}
                        className="inline-flex items-center justify-center rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-ivory-50 transition-colors hover:bg-ink-800 dark:bg-ivory-100 dark:text-ink-900 dark:hover:bg-ivory-200"
                      >
                        Abrir a sala
                      </Link>
                      <form action={syncGroupAction}>
                        <input type="hidden" name="groupId" value={group.id} />
                        <Button type="submit" variant="outline" size="sm">
                          Sincronizar membras
                        </Button>
                      </form>
                      <form action={houseRulesAction}>
                        <input type="hidden" name="groupId" value={group.id} />
                        <Button type="submit" variant="outline" size="sm">
                          Aplicar regras da casa
                        </Button>
                      </form>
                      {paused ? (
                        <form action={resumeGroupAction}>
                          <input type="hidden" name="groupId" value={group.id} />
                          <Button type="submit" variant="outline" size="sm">
                            Retomar
                          </Button>
                        </form>
                      ) : (
                        <form action={pauseGroupAction}>
                          <input type="hidden" name="groupId" value={group.id} />
                          <input type="hidden" name="days" value="7" />
                          <Button type="submit" variant="outline" size="sm">
                            Pausar 7 dias
                          </Button>
                        </form>
                      )}
                      <form action={setGroupActiveAction}>
                        <input type="hidden" name="groupId" value={group.id} />
                        <input type="hidden" name="nextActive" value={group.isActive ? "false" : "true"} />
                        <Button type="submit" variant="outline" size="sm">
                          {group.isActive ? "Desligar sala" : "Ligar sala"}
                        </Button>
                      </form>
                    </div>
                  </div>
                  {group.invitationLink ? (
                    <div className="mt-4">
                      <CopyField
                        label="Link de convite"
                        value={group.invitationLink}
                        hint={`É este link que a ${sellerName} vai entregar depois do opt-in. Não cole em lugar público: quem entra sem passar pela ${sellerName} não recebe aviso no privado.`}
                      />
                    </div>
                  ) : (
                    <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">Sem link de convite: o número da loja precisa ser admin do grupo. Aplique as regras da casa para buscar o link.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
