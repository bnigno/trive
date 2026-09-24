import type { Metadata } from "next";
import Link from "next/link";

import { getAdapterMode } from "@/adapters/adapter-mode";
import { isImageStudioConfigured } from "@/adapters/image-studio";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import { getFileStorage } from "@/adapters/storage";
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
import { listCampaignLinks, type CampaignLink } from "@/services/campaign-links";
import { getLastDigest } from "@/services/daily-digest";
import { countUnseenConversations } from "@/services/wa-conversations";
import {
  getBotActivitySummary,
  getBotResponseTimes,
  listRecentBotActivity,
  type BotActivityEvent,
  type BotActivitySummary,
  type BotResponseTimes,
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
import type { LiaGiftPolicy } from "@/core/coupons/lia-gift";
import { countLiaGiftsToday, loadLiaGiftPolicy } from "@/services/lia-gifts";
import { INTERVIEW_STATUS_LABELS } from "@/core/atelier/interview";
import {
  INTERVIEW_PROBLEM_TEXT,
  interviewProblems,
  listRecentInterviews,
  loadInterviewSettings,
  type InterviewProblem,
  type InterviewSettings,
  type InterviewSummary,
} from "@/services/curator-interviews";
import { maskPhone } from "./conversas/format";
import {
  AskInterviewNowForm,
  BotSettingsForm,
  InterviewScheduleForm,
  LiaGiftSettingsForm,
  SendDigestNowForm,
  SendTestMessageForm,
  TemplateEditForm,
  ToggleSwitch,
  WaSettingsForm,
} from "./forms";
import { QrAutoRefresh } from "./qr-auto-refresh";
import { Rehearsal } from "./rehearsal";
import { ResponseTimes } from "./response-times";
import { brandWordWarning } from "@/core/bot/owner-instructions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vendedora & WhatsApp",
};

// ---------------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------------

interface PageData {
  overview: WaSessionOverview | null;
  interview: { settings: InterviewSettings; recent: InterviewSummary[]; problems: InterviewProblem[] } | null;
  waEnabledSetting: boolean;
  ownerPhone: string;
  recoveryAfterMinutes: number;
  botEnabledSetting: boolean;
  catalogDraftEnabled: boolean;
  atelierEnabled: boolean;
  aiPhotosEnabled: boolean;
  aiPhotosInStore: boolean;
  feedbackAskEnabled: boolean;
  customerLooksEnabled: boolean;
  audioNotesEnabled: boolean;
  friendsVoteEnabled: boolean;
  handoffSilenceHours: number;
  handoffAutoReturnHours: number;
  idleCartFollowupHours: number;
  botModel: string;
  botMode: string;
  sellerName: string;
  exchangePolicy: string;
  botExtraInstructions: string;
  quickReplies: string;
  templates: WaTemplate[];
  summary: BotActivitySummary;
  responseTimes: BotResponseTimes;
  activity: BotActivityEvent[];
  awaitingOwner: number;
  digestEnabled: boolean;
  mediaEnabled: boolean;
  photoMatchEnabled: boolean;
  cardsEnabled: boolean;
  lastDigest: { date: string; url: string; at: Date } | null;
  /** Resumo dos links de story (a lista completa fica em /whatsapp/links). */
  campaignLinks: { total: number; taps: number; conversations: number; orders: number };
  /** Gentilezas da Lia: a política e quantas saíram hoje. */
  liaGift: { enabled: boolean; policy: LiaGiftPolicy; today: number };
}

async function loadPageData(): Promise<PageData | null> {
  const db = getDb();

  let settingsMap: Record<string, unknown>;
  let templates: WaTemplate[];
  let summary: BotActivitySummary;
  let responseTimes: BotResponseTimes;
  let activity: BotActivityEvent[];
  let awaitingOwner: number;
  let lastDigestRow: Awaited<ReturnType<typeof getLastDigest>>;
  let campaignLinks: CampaignLink[];
  let liaGiftPolicy: LiaGiftPolicy;
  let liaGiftsToday: number;
  try {
    [settingsMap, templates, summary, responseTimes, activity, awaitingOwner, lastDigestRow, campaignLinks] = await Promise.all([
      getSettingsMap(db, [
        "wa_enabled",
        "owner_whatsapp_phone",
        "wa_recovery_after_minutes",
        "bot_enabled",
        "bot_model",
        "bot_mode",
        "bot_idle_cart_followup_hours",
        "bot_seller_name",
        "store_exchange_policy",
        "bot_extra_instructions",
        "wa_quick_replies",
        "owner_digest_enabled",
        "bot_media_enabled",
        "bot_photo_match_enabled",
        "bot_cards_enabled",
        "handoff_silence_hours",
        "handoff_auto_return_hours",
        "catalog_draft_enabled",
        "atelier_enabled",
        "feedback_ask_enabled",
        "customer_looks_enabled",
        "bot_audio_notes_enabled",
        "lia_gift_enabled",
        "ai_photos_enabled",
        "ai_photos_in_store",
        "friends_vote_enabled",
      ]),
      listWaTemplates(db),
      getBotActivitySummary(db),
      getBotResponseTimes(db),
      listRecentBotActivity(db, { limit: 8 }),
      countUnseenConversations(db).then((counts) => counts.awaitingOwner),
      getLastDigest(db),
      listCampaignLinks(db),
    ]);
    [liaGiftPolicy, liaGiftsToday] = await Promise.all([loadLiaGiftPolicy(db), countLiaGiftsToday(db, new Date())]);
  } catch {
    return null;
  }

  // Entrevista da curadora à parte: a tabela nova não pode derrubar a página.
  let interview: { settings: InterviewSettings; recent: InterviewSummary[]; problems: InterviewProblem[] } | null = null;
  try {
    interview = { settings: await loadInterviewSettings(db), recent: await listRecentInterviews(db, 5), problems: await interviewProblems(db) };
  } catch {
    interview = null;
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
  const hours = (key: string, fallback: number): number => {
    const raw = settingsMap[key];
    return typeof raw === "number" && Number.isInteger(raw) ? raw : fallback;
  };
  return {
    overview,
    interview,
    waEnabledSetting: settingsMap["wa_enabled"] === true,
    ownerPhone: text("owner_whatsapp_phone"),
    recoveryAfterMinutes:
      typeof rawMinutes === "number" && Number.isFinite(rawMinutes)
        ? rawMinutes
        : 60,
    botEnabledSetting: settingsMap["bot_enabled"] === true,
    catalogDraftEnabled: settingsMap["catalog_draft_enabled"] !== false,
    atelierEnabled: settingsMap["atelier_enabled"] !== false,
    aiPhotosEnabled: settingsMap["ai_photos_enabled"] === true,
    aiPhotosInStore: settingsMap["ai_photos_in_store"] === true,
    feedbackAskEnabled: settingsMap["feedback_ask_enabled"] !== false,
    customerLooksEnabled: settingsMap["customer_looks_enabled"] !== false,
    audioNotesEnabled: settingsMap["bot_audio_notes_enabled"] !== false,
    friendsVoteEnabled: settingsMap["friends_vote_enabled"] === true,
    handoffSilenceHours: hours("handoff_silence_hours", 24),
    handoffAutoReturnHours: hours("handoff_auto_return_hours", 12),
    idleCartFollowupHours: hours("bot_idle_cart_followup_hours", 0),
    botModel: text("bot_model") || "claude-sonnet-5",
    botMode: text("bot_mode") === "copilot" ? "copilot" : "autonomous",
    sellerName: text("bot_seller_name").trim() || DEFAULT_SELLER_NAME,
    exchangePolicy: text("store_exchange_policy"),
    botExtraInstructions: text("bot_extra_instructions"),
    quickReplies: text("wa_quick_replies"),
    templates,
    summary,
    responseTimes,
    activity,
    awaitingOwner,
    digestEnabled: settingsMap["owner_digest_enabled"] !== false,
    mediaEnabled: settingsMap["bot_media_enabled"] !== false,
    photoMatchEnabled: settingsMap["bot_photo_match_enabled"] !== false,
    cardsEnabled: settingsMap["bot_cards_enabled"] !== false,
    campaignLinks: {
      total: campaignLinks.length,
      taps: campaignLinks.reduce((sum, link) => sum + link.taps, 0),
      conversations: campaignLinks.reduce((sum, link) => sum + link.conversations, 0),
      orders: campaignLinks.reduce((sum, link) => sum + link.orders, 0),
    },
    lastDigest: lastDigestRow
      ? {
          date: lastDigestRow.date,
          url: `${getFileStorage().publicUrl(lastDigestRow.path)}?v=${lastDigestRow.at.getTime()}`,
          at: lastDigestRow.at,
        }
      : null,
    liaGift: { enabled: settingsMap["lia_gift_enabled"] === true, policy: liaGiftPolicy, today: liaGiftsToday },
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
    botMode,
    sellerName,
    exchangePolicy,
    botExtraInstructions,
    quickReplies,
    templates,
    summary,
    responseTimes,
    activity,
    awaitingOwner,
    digestEnabled,
    mediaEnabled,
    cardsEnabled,
    lastDigest,
    liaGift,
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
          <ToggleSwitch
            settingKey="bot_media_enabled"
            checked={mediaEnabled}
            label={`A ${sellerName} vê fotos e ouve áudios`}
            hint={
              isTranscriptionConfigured()
                ? "Foto da cliente (print, peça do armário, convite) vai para a inteligência; áudio é transcrito. Centavos por uso; nada da foto é guardado além de uma impressão digital de 16 caracteres, para reconhecer a peça."
                : "Fotos vão para a inteligência (centavos por uso). Áudio exige a chave da OpenAI na hospedagem — sem ela, a vendedora pede para escrever."
            }
          />
          <ToggleSwitch
            settingKey="bot_photo_match_enabled"
            checked={data.photoMatchEnabled}
            label={`A ${sellerName} reconhece a peça na foto`}
            hint="Foto da própria loja repassada pela cliente (post, site, etiqueta): compara com as fotos do catálogo pela impressão digital (grátis) e, se não bater, com até 8 peças parecidas pela inteligência (centavos). Desligado, ela volta a descrever a foto e buscar parecidas. A impressão digital (16 caracteres, irreversível) é calculada com ou sem este interruptor; a foto em si nunca é guardada."
          />
          <ToggleSwitch
            settingKey="catalog_draft_enabled"
            checked={data.catalogDraftEnabled}
            label="Começar pela foto no cadastro"
            hint="Em Novo produto, você fotografa a peça e a etiqueta e a ficha volta preenchida para revisar (nome, descrição, composição, cuidados, cores, tamanhos, peso e preço sugerido). Centavos por peça; nada é salvo sem a sua revisão."
          />
          <ToggleSwitch
            settingKey="atelier_enabled"
            checked={data.atelierEnabled}
            label="Ateliê pelo WhatsApp"
            hint="Do SEU celular (o número cadastrado em Conexão), mande as fotos da peça para o número da TRIVÉ e depois um recado com o nome dela — texto ou áudio. A peça nasce em rascunho, com as fotos, e você recebe o link. Texto solto seu continua indo para a Lia, como cliente."
          />
          <ToggleSwitch
            settingKey="feedback_ask_enabled"
            checked={data.feedbackAskEnabled}
            label="Chegou bem? um dia depois da entrega"
            hint="Uma lista tocável (Amei · Ficou grande · Ficou pequeno · Veio com defeito · Quero falar com alguém), das 9h às 21h, uma vez por pedido e só com opt-in. Grande/pequeno a Lia acolhe e transfere a troca; defeito e “falar” vêm direto para você. As respostas viram o sinal de caimento na peça."
          />
          <ToggleSwitch
            settingKey="customer_looks_enabled"
            checked={data.customerLooksEnabled}
            label="Quem já vestiu"
            hint="Quando a cliente manda uma foto dela usando a peça que comprou, a Lia guarda a foto, ela recebe o cartão “Ana veste …” e a pergunta tocável se pode aparecer na página da peça. Só entra na vitrine com o “sim” dela e a sua aprovação em Produtos › Quem já vestiu; ela retira quando quiser."
          />
          <ToggleSwitch
            settingKey="bot_audio_notes_enabled"
            checked={data.audioNotesEnabled}
            label="A Lia manda a voz da curadora"
            hint="Quando a cliente pergunta de tecido, caimento ou calor de uma peça com nota em áudio, a Lia diz que a curadora gravou uma nota e a cliente recebe o áudio como mensagem de voz no WhatsApp — uma vez por peça na conversa. Desligado, a Lia cita só a nota escrita."
          />
          <ToggleSwitch
            settingKey="friends_vote_enabled"
            checked={data.friendsVoteEnabled}
            label="Me ajuda a escolher? (votação das amigas)"
            hint={`Quando a cliente fica em dúvida entre 2 ou 3 peças, a ${sellerName} oferece (uma vez) uma votação. A CLIENTE encaminha o cartão com o link às amigas; cada uma vota com um toque, sem cadastro e sem telefone, e pode deixar um recado. O placar volta para a cliente pelo WhatsApp da loja — 10 minutos depois do primeiro voto e quando a votação fecha, com os recados e o nome de quem quis assinar (sem link nem telefone); fora das 9h às 21h, espera a manhã. Quem votou pode abrir uma conversa com a ${sellerName}; a loja nunca escreve primeiro para ninguém. Nada fica reservado durante a votação, e SAIR da cliente encerra a votação dela.`}
          />
          <ToggleSwitch
            settingKey="bot_cards_enabled"
            checked={cardsEnabled}
            label="Cartões editoriais no WhatsApp"
            hint="Junto com a lista tocável vai um cartão com as fotos das peças (a vitrine em imagem); depois do pedido, o cartão do look completo. Desligado, só a lista."
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

      {/* Foto no corpo (ensaio com modelos da casa) */}
      <Card title="Foto no corpo">
        <div className="flex flex-col gap-5">
          <div className="grid gap-6 md:grid-cols-2">
            <ToggleSwitch
              settingKey="ai_photos_enabled"
              checked={data.aiPhotosEnabled}
              label="Gerar a peça no corpo de uma modelo da casa"
              hint="Na peça, o bloco “Foto no corpo” gera 3 opções (a foto real esticada veste a modelo, numa cena de Belém); a inteligência confere estampa, cor e corte antes de você ver. Centavos por foto (a conta aparece no botão); cota diária em Configurações. Exige a chave da FASHN na hospedagem e uma foto-base escolhida em Modelos da casa."
            />
            <ToggleSwitch
              settingKey="ai_photos_in_store"
              checked={data.aiPhotosInStore}
              label="Foto no corpo também na vitrine"
              hint="Desligado, a foto gerada aparece só no post do Instagram e nos cartões da Lia; a loja segue com as fotos reais. Ligue quando gostar da qualidade."
            />
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link href="/admin/produtos/modelos-da-casa" className="font-medium text-zinc-900 underline dark:text-zinc-100">
              Modelos da casa (fotos-base)
            </Link>
            <Link href="/admin/configuracoes#foto-no-corpo" className="font-medium text-zinc-900 underline dark:text-zinc-100">
              Cota, qualidade e cena padrão
            </Link>
          </div>
          {data.aiPhotosEnabled && !isImageStudioConfigured() ? (
            <Warning>
              A foto no corpo está ligada, mas a chave da FASHN (FASHN_API_KEY) ainda não foi configurada na hospedagem — os pedidos vão para a fila e falham até ela existir.
            </Warning>
          ) : null}
        </div>
      </Card>

      {/* Bom dia da maison */}
      <Card title="Bom dia da TRIVÉ">
        <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-start">
          <ToggleSwitch
            settingKey="owner_digest_enabled"
            checked={digestEnabled}
            label="Resumo diário no seu WhatsApp"
            hint="Todo dia às 8h você recebe uma imagem com o resumo de ontem: vendas, o que espera você, o que a Lia fez, estoque baixo e a peça da semana."
          />
          <div className="flex flex-col items-start gap-2">
            <SendDigestNowForm />
            {lastDigest ? (
              <a
                href={lastDigest.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Ver o último resumo ({lastDigest.date.split("-").reverse().slice(0, 2).join("/")})
              </a>
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Nenhum resumo enviado ainda.</p>
            )}
          </div>
        </div>
      </Card>

      <Card title="Entrevista da curadora">
        {data.interview ? (
          <div className="flex flex-col gap-5">
            <ToggleSwitch
              settingKey="curator_interview_enabled"
              checked={data.interview.settings.enabled}
              label="Uma pergunta por dia sobre uma peça"
              hint={`Na hora escolhida, a ${sellerName} manda no seu WhatsApp a foto de uma peça e uma pergunta (“por que você trouxe?”, “pra onde você usaria?”). Você responde com um ou mais áudios até a noite e recebe o rascunho da nota da curadora e duas legendas; só entra na peça com o seu “ok”. “ok voz” guarda também o seu áudio, inteiro, como a voz da curadora — ele toca na página da peça. Começa pelas peças da edição da cidade sem a sua voz. Se três perguntas seguidas ficarem sem resposta (ou puladas), ela passa a perguntar só às segundas.`}
            />
            {data.interview.problems.filter((problem) => problem !== "nada_a_perguntar" || data.interview?.settings.enabled).map((problem) => (
              <Warning key={problem}>{INTERVIEW_PROBLEM_TEXT[problem]}</Warning>
            ))}
            <InterviewScheduleForm hour={data.interview.settings.hour} weekends={data.interview.settings.weekends} />
            <AskInterviewNowForm />
            {data.interview.recent.length > 0 ? (
              <ul className="flex flex-col gap-2 text-sm">
                {data.interview.recent.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-x-2">
                    <Link href={`/admin/produtos/${row.productId}`} className="font-medium text-zinc-900 underline dark:text-zinc-100">
                      {row.productName}
                    </Link>
                    <span className="text-zinc-500 dark:text-zinc-400">{INTERVIEW_STATUS_LABELS[row.status]}</span>
                    <span className="text-xs text-zinc-400">{formatDateTimeSP(row.askedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Nenhuma pergunta feita ainda.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Não foi possível carregar a entrevista agora. Tente recarregar a página.</p>
        )}
      </Card>

      <Card title={`Gentilezas da ${sellerName}`}>
        <div className="flex flex-col gap-5">
          <ToggleSwitch
            settingKey="lia_gift_enabled"
            checked={liaGift.enabled}
            label={`A ${sellerName} pode oferecer uma gentileza`}
            hint={`Um cupom pessoal, de poucos dias, para a cliente que hesitou no preço, é de casa ou está de aniversário — dentro da cota do dia. A ${sellerName} nunca oferece na abertura nem duas vezes na mesma conversa; cada gentileza fica registrada em Cupons com o motivo.`}
          />
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Hoje: <span className="font-medium">{liaGift.today} de {liaGift.policy.dailyQuota}</span>
            {liaGift.enabled ? "" : " · desligado"}
          </p>
          <LiaGiftSettingsForm
            defaults={{
              percent: liaGift.policy.percent,
              dailyQuota: liaGift.policy.dailyQuota,
              minPurchases: liaGift.policy.minPurchases,
              minCart: (liaGift.policy.minCartCents / 100).toFixed(2).replace(".", ","),
              validDays: liaGift.policy.validDays,
              cooldownDays: liaGift.policy.cooldownDays,
            }}
          />
        </div>
      </Card>

      {/* A vendedora */}
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card title={`A ficha da ${sellerName}`}>
          <BotSettingsForm
            sellerName={sellerName}
            botModel={botModel}
            botMode={botMode}
            exchangePolicy={exchangePolicy}
            exchangePolicyWarning={brandWordWarning(exchangePolicy)}
            botExtraInstructions={botExtraInstructions}
            quickReplies={quickReplies}
            handoffSilenceHours={data.handoffSilenceHours}
            handoffAutoReturnHours={data.handoffAutoReturnHours}
            idleCartFollowupHours={data.idleCartFollowupHours}
          />
        </Card>
        <div className="flex flex-col gap-6">
          <Card title={`Testar a ${sellerName}`}>
            <Rehearsal sellerName={sellerName} />
          </Card>
          <Card title={`Tempo de resposta da ${sellerName} (${responseTimes.windowDays} dias)`}>
            <ResponseTimes times={responseTimes} sellerName={sellerName} />
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
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  {usdCents(summary.estimatedCostUsdCents)}
                  {summary.studioImages > 0 ? (
                    <span className="ml-1 text-xs font-normal text-zinc-500">
                      + fotos no corpo {usdCents(summary.studioUsdCents)} ({summary.studioImages})
                    </span>
                  ) : null}
                </dd>
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

      {/* Links de story e origens */}
      <Card title="Do site e dos stories para a vendedora">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {data.campaignLinks.total === 0
              ? `Crie um link curto (ex.: /ig/dunas) para o sticker do story: quem toca cai no WhatsApp da ${sellerName} já falando da peça. O botão "Falar com a ${sellerName}" do site já conta sozinho.`
              : `${data.campaignLinks.total} ${data.campaignLinks.total === 1 ? "link de story" : "links de story"} · ${data.campaignLinks.taps} ${data.campaignLinks.taps === 1 ? "toque" : "toques"} → ${data.campaignLinks.conversations} ${data.campaignLinks.conversations === 1 ? "conversa" : "conversas"} → ${data.campaignLinks.orders} ${data.campaignLinks.orders === 1 ? "pedido" : "pedidos"}`}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href="/admin/whatsapp/origens"
              className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              De onde vieram
            </Link>
            <Link
              href="/admin/whatsapp/links"
              className="inline-flex items-center justify-center rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-ivory-50 transition-colors hover:bg-ink-800 dark:bg-ivory-100 dark:text-ink-900 dark:hover:bg-ivory-200"
            >
              {data.campaignLinks.total === 0 ? "Criar o primeiro link" : "Links de story"}
            </Link>
          </div>
        </div>
      </Card>

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
