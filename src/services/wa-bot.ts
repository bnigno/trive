// VENDEDORA DE IA no WhatsApp (Fase 5 / Onda 3): executa UM turno de conversa
// por evento 'wa.bot_turn' da fila. A IA nunca é fonte de fatos — preço,
// estoque, frete e pedido saem das ferramentas (executores por família em
// src/services/bot/*), que devolvem blocos pt-BR prontos. Regras duras: resposta idempotente por mensagem
// inbound (dedupe em wa_messages), transferência para humano SEMPRE audita e
// silencia o bot por 24h, e nada aqui toca o fluxo SAIR/opt-out (wa-inbound).
//
// Memória: o "caderninho" (src/core/bot/memory.ts) vive em
// wa_conversations.bot_state e entra no turno como primeira mensagem, fora do
// prompt de sistema — que se mantém idêntico entre turnos para o cache valer.
import { and, desc, eq } from "drizzle-orm";
import { getAdapterMode } from "@/adapters/adapter-mode";
import {
  AssistantUnavailableError,
  type AssistantTurn,
  type BotChatMessage,
  type SalesAssistant,
} from "@/adapters/assistant";
import { getCepLookup } from "@/adapters/cep";
import type { MessagingProvider } from "@/adapters/zapi";
import { parseBotState, renderContextNote, type BotState } from "@/core/bot/memory";
import { copilotBlockedText, isToolBlockedInCopilot } from "@/core/bot/copilot";
import { BOT_TOOL_INPUT_SCHEMAS, type BotToolInputs, type ToolExecutor } from "@/core/bot/tools";
import { buildBotSystemPrompt, DEFAULT_SELLER_NAME, truncateForWhatsApp } from "@/core/bot/prompt";
import { splitBotReply } from "@/core/bot/reply";
import { isBridgeFresh } from "@/core/bot/site-bridge";
import { renderStoreMap } from "@/core/bot/store-map";
import {
  historyTextForInbound,
  isAudioAwaitingTranscription,
  parseWaMediaMeta,
} from "@/core/whatsapp/media";
import { deriveWaMessageOrigin, isProactiveBotReply } from "@/core/whatsapp/origin";
import { auditLog, waConversations, waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { bridgeStockLine } from "@/services/site-carts";
import { isBotMediaEnabled, loadTurnImages, MAX_IMAGES_PER_TURN } from "@/services/wa-media";
import { getStoreMap } from "@/services/store-catalog";
import {
  isWaEnabled,
  sendMediaMessage,
  sendTemplateMessage,
  siteBaseUrl,
} from "@/services/wa-messaging";

import {
  execAdicionarASacola,
  execRemoverDaSacola,
  execValidarCupom,
  execVerSacola,
} from "./bot/cart";
import { execDetalharProduto, execListarProdutos, execMontarLook } from "./bot/catalog";
import { execEnviarNotaDaCuradora } from "./bot/curator-audio";
import { execBuscarCadastro } from "./bot/customer";
import { execAvisarQuandoVoltar, execLiberarReserva, execReservarPeca } from "./bot/holds";
import {
  execConfirmarEntrega,
  execCriarPedido,
  execEnviarChavePix,
  execHistoricoDeCompras,
  execStatusDoPedido,
  purchaseMemoryLineFor,
  shipmentMemoryLineFor,
} from "./bot/orders";
import { execAvisarDono, execTransferir, handOffToHuman } from "./bot/owner";
import {
  BOT_UNAVAILABLE_REPLY,
  DEFAULT_BOT_MODEL,
  DEFAULT_STORE_NAME,
  HANDOFF_COURTESY_REPLY,
  HISTORY_LIMIT,
  makeCardEmitter,
} from "./bot/shared";
import type {
  BotAttachment,
  BotCardDeps,
  BotExecutorContext,
  ExecutorCtx,
  RunBotTurnResult,
} from "./bot/shared";
import { execCotarFrete } from "./bot/shipping";
import { execAgendarRetorno } from "./bot/followups";
import { execRegistrarFotoComAPeca, execRetirarMinhaFoto } from "./bot/looks";
import { LOOK_PHOTO_WINDOW_MS } from "./customer-looks";
import { followupMemoryLines } from "./wa-followups";
import { FOLLOWUP_GRACE_MINUTES, isFollowupSuperseded, isFollowupTooLate, renderFollowupPrompt, type FollowupKind } from "@/core/bot/followup";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import { BOT_FOLLOWUP_EVENT, idleCartStillValid } from "./wa-followups";
import { waFollowups } from "@/db/schema";
import { isWithinSendWindow, nextSendWindowStart } from "@/core/whatsapp/send-window";
import { enqueueOutboxEvent } from "@/queue/enqueue";
import { loadSendPolicy } from "./wa-send-policy";
import { spDayKey } from "@/lib/sp-day";
import { customers } from "@/db/schema";
import { createSuggestion, enqueueSuggestionNotice, findSuggestionByInbound, resolveConversationBotMode, supersedePendingSuggestions } from "./wa-suggestions";
import { execAnotar, execAtualizarCartela, execSugerirTamanho, loadMemoryLines } from "./bot/style";

// Superfície pública: quem importa de @/services/wa-bot continua igual; os
// executores moram em src/services/bot/* por família.
export { BOT_UNAVAILABLE_REPLY, CARD_TIMEOUT_MS, HANDOFF_COURTESY_REPLY } from "./bot/shared";

export type {
  BotAttachment,
  BotCardDeps,
  BotExecutorContext,
  RunBotTurnResult,
} from "./bot/shared";

// ---------------------------------------------------------------------------
// isBotEnabled — toggle bot_enabled E WhatsApp funcional E (modo fake OU
// ANTHROPIC_API_KEY). Sem qualquer um deles, o inbound segue para o dono.
// ---------------------------------------------------------------------------

export async function isBotEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["bot_enabled"]);
  if (map["bot_enabled"] !== true) return false;
  if (!(await isWaEnabled(db))) return false;
  if (getAdapterMode() === "fake") return true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return typeof apiKey === "string" && apiKey.trim() !== "";
}

// ---------------------------------------------------------------------------
// Histórico enviado ao modelo
// ---------------------------------------------------------------------------

/**
 * Texto que uma mensagem antiga assume no histórico enviado ao modelo.
 *
 * O body de um option_list é gravado JÁ RENDERIZADO ("Toque abaixo…" + uma
 * linha por produto com preço) porque é o que a thread do admin exibe. Só que
 * isso, no histórico, é uma lista pronta convidando a ser copiada — e o modelo
 * copia: em 26/08 ele reemitiu a lista inteira como texto puro, sem chamar
 * listar_produtos, e o cliente ficou sem os botões (a lista interativa só sai
 * quando a ferramenta roda de verdade). Trocar pelo marcador remove a cola:
 * para mostrar produtos, o modelo é OBRIGADO a chamar a ferramenta.
 */
export function historyTextFor(kind: string, body: string): string {
  if (kind === "option_list") {
    return "[lista tocável do catálogo enviada ao cliente]";
  }
  if (kind === "image") {
    return `[foto enviada ao cliente] ${body}`;
  }
  return body;
}

/**
 * Mensagem de saída que NÃO foi a vendedora (resposta manual da equipe,
 * aviso automático de pedido, ack de SAIR) entra no histórico com a origem
 * marcada — senão o modelo "assume" promessas do dono ou repete templates.
 */
export function historyTextForOutbound(input: {
  kind: string;
  body: string;
  dedupeKey: string | null;
  templateKey: string | null;
  status?: string;
}): string {
  const origin = deriveWaMessageOrigin({
    direction: "outbound",
    dedupeKey: input.dedupeKey,
    templateKey: input.templateKey,
  });
  // Mídia que o provedor recusou fica na conversa como 'failed': o modelo
  // precisa saber que a cliente NÃO recebeu (senão insiste "ouve acima").
  const failed = input.status === "failed";
  const text =
    input.kind === "audio"
      ? `[mensagem de voz ${failed ? "que NÃO chegou à cliente (falhou)" : "enviada à cliente"}] ${input.body}`
      : failed && input.kind === "image"
        ? `[foto que NÃO chegou ao cliente (falhou)] ${input.body}`
        : historyTextFor(input.kind, input.body);
  if (isProactiveBotReply(input.dedupeKey)) {
    return `[você chamou como combinado] ${text}`;
  }
  if (origin === "manual") {
    return `[mensagem enviada pela equipe da loja, não por você] ${text}`;
  }
  if (origin === "auto") {
    return `[aviso automático da loja] ${text}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// buildToolExecutor — valida o input (Zod) e despacha para o executor da família
// ---------------------------------------------------------------------------

export function buildToolExecutor(
  db: DbOrTx,
  baseCtx: BotExecutorContext,
): ToolExecutor {
  const ctx: ExecutorCtx = {
    ...baseCtx,
    ...(baseCtx.dryRun && !baseCtx.stateOverlay ? { stateOverlay: { current: null } } : {}),
    turnAudioUrls: baseCtx.turnAudioUrls ?? new Set<string>(),
    emitCard: makeCardEmitter(db, baseCtx),
  };
  return async (name, rawInput) => {
    // Copiloto: o que tem efeito fora da conversa espera a dona.
    if (ctx.copilot && isToolBlockedInCopilot(name)) return { ok: false, text: copilotBlockedText(name) };
    const schema = BOT_TOOL_INPUT_SCHEMAS[name];
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      const detalhes = parsed.error.issues
        .map((issue) => issue.message)
        .join("; ");
      return { ok: false, text: `Dados inválidos: ${detalhes}` };
    }

    switch (name) {
      case "listar_produtos":
        return execListarProdutos(
          db,
          ctx,
          parsed.data as BotToolInputs["listar_produtos"],
        );
      case "detalhar_produto":
        return execDetalharProduto(
          db,
          ctx,
          parsed.data as BotToolInputs["detalhar_produto"],
        );
      case "adicionar_a_sacola":
        return execAdicionarASacola(
          db,
          ctx,
          parsed.data as BotToolInputs["adicionar_a_sacola"],
        );
      case "ver_sacola":
        return execVerSacola(db, ctx);
      case "remover_da_sacola":
        return execRemoverDaSacola(
          db,
          ctx,
          parsed.data as BotToolInputs["remover_da_sacola"],
        );
      case "validar_cupom":
        return execValidarCupom(
          db,
          ctx,
          parsed.data as BotToolInputs["validar_cupom"],
        );
      case "cotar_frete":
        return execCotarFrete(db, ctx, parsed.data as BotToolInputs["cotar_frete"]);
      case "buscar_cadastro":
        return execBuscarCadastro(db, ctx);
      case "historico_de_compras":
        return execHistoricoDeCompras(db, ctx);
      case "criar_pedido":
        return execCriarPedido(db, ctx, parsed.data as BotToolInputs["criar_pedido"]);
      case "confirmar_entrega":
        return execConfirmarEntrega(db, ctx, parsed.data as BotToolInputs["confirmar_entrega"]);
      case "status_do_pedido":
        return execStatusDoPedido(
          db,
          ctx,
          parsed.data as BotToolInputs["status_do_pedido"],
        );
      case "enviar_chave_pix":
        return execEnviarChavePix(
          db,
          ctx,
          parsed.data as BotToolInputs["enviar_chave_pix"],
        );
      case "avisar_dono":
        return execAvisarDono(
          db,
          ctx,
          parsed.data as BotToolInputs["avisar_dono"],
        );
      case "reservar_peca":
        return execReservarPeca(db, ctx, parsed.data as BotToolInputs["reservar_peca"]);
      case "liberar_reserva":
        return execLiberarReserva(db, ctx);
      case "avisar_quando_voltar":
        return execAvisarQuandoVoltar(db, ctx, parsed.data as BotToolInputs["avisar_quando_voltar"]);
      case "atualizar_cartela":
        return execAtualizarCartela(db, ctx, parsed.data as BotToolInputs["atualizar_cartela"]);
      case "montar_look":
        return execMontarLook(db, ctx, parsed.data as BotToolInputs["montar_look"]);
      case "anotar":
        return execAnotar(db, ctx, parsed.data as BotToolInputs["anotar"]);
      case "sugerir_tamanho":
        return execSugerirTamanho(db, ctx, parsed.data as BotToolInputs["sugerir_tamanho"]);
      case "enviar_nota_da_curadora":
        return execEnviarNotaDaCuradora(db, ctx, parsed.data as BotToolInputs["enviar_nota_da_curadora"]);
      case "registrar_foto_com_a_peca":
        return execRegistrarFotoComAPeca(db, ctx, parsed.data as BotToolInputs["registrar_foto_com_a_peca"]);
      case "retirar_minha_foto":
        return execRetirarMinhaFoto(db, ctx);
      case "agendar_retorno":
        return execAgendarRetorno(db, ctx, parsed.data as BotToolInputs["agendar_retorno"]);
      case "transferir_para_atendente":
        return execTransferir(
          db,
          ctx,
          parsed.data as BotToolInputs["transferir_para_atendente"],
        );
    }
  };
}

// ---------------------------------------------------------------------------
// Prompt do turno: configurações + planta da loja. Compartilhado com o
// ensaio do painel ("Testar a vendedora").
// ---------------------------------------------------------------------------

export type BotPromptBundle = {
  system: string;
  model: string;
  sellerName: string;
};

export async function buildBotPromptBundle(db: DbOrTx): Promise<BotPromptBundle> {
  const map = await getSettingsMap(db, [
    "store_name",
    "bot_extra_instructions",
    "bot_model",
    "bot_seller_name",
    "store_exchange_policy",
  ]);
  const text = (key: string): string =>
    typeof map[key] === "string" ? (map[key] as string).trim() : "";
  const storeName = text("store_name") || DEFAULT_STORE_NAME;
  const model = text("bot_model") || DEFAULT_BOT_MODEL;
  const sellerName = text("bot_seller_name") || DEFAULT_SELLER_NAME;

  const storeMap = renderStoreMap(await getStoreMap(db));

  const system = buildBotSystemPrompt({
    storeName,
    sellerName,
    extraInstructions: text("bot_extra_instructions"),
    siteUrl: siteBaseUrl(),
    ...(storeMap ? { storeMap } : {}),
    exchangePolicy: text("store_exchange_policy"),
  });
  return { system, model, sellerName };
}

/** Histórico + caderninho como o modelo recebe (primeira mensagem = contexto). */
export function assembleHistory(
  state: BotState,
  messages: BotChatMessage[],
  extras: { lines?: readonly string[]; now?: Date } = {},
): BotChatMessage[] {
  const note = renderContextNote(state, extras);
  return note ? [{ role: "user", text: note }, ...messages] : messages;
}

// ---------------------------------------------------------------------------
// loadTurnHistory — as últimas mensagens da conversa como o modelo recebe
// (fotos do turno anexadas, as antigas em marcador) + o caderninho. É o
// mesmo para o turno reativo (runBotTurn) e para o proativo
// (runScheduledBotTurn); o segundo acrescenta a fala sintética no fim.
// ---------------------------------------------------------------------------

type TurnConversation = typeof waConversations.$inferSelect;

export type LoadedTurnHistory = {
  history: BotChatMessage[];
  recentImages: Array<{ waMessageId: string; mediaUrl: string }>;
  /** Só contagens para a trilha: a foto nunca é guardada. */
  media: { images: number; audios: number };
  lastInboundAt: Date | null;
  /** Mensagens dela depois da última saída — zero = já respondida. */
  pendingInbound: number;
};

export async function loadTurnHistory(
  tx: DbOrTx,
  provider: MessagingProvider,
  input: { conversation: TurnConversation; now: Date },
): Promise<LoadedTurnHistory | { skipped: "aguardando_transcricao" }> {
  const { conversation, now } = input;
  const conversationId = conversation.id;
  // Histórico: últimas mensagens em ordem cronológica, com a origem de cada
  // saída marcada (equipe/automático) e mídia resumida em marcadores.
  const recent = await tx
    .select({
      id: waMessages.id,
      direction: waMessages.direction,
      body: waMessages.body,
      kind: waMessages.kind,
      dedupeKey: waMessages.dedupeKey,
      templateKey: waMessages.templateKey,
      mediaUrl: waMessages.mediaUrl,
      mediaMeta: waMessages.mediaMeta,
      status: waMessages.status,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(eq(waMessages.conversationId, conversationId))
    .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
    .limit(HISTORY_LIMIT);
  const rows = recent.reverse();

  // "Pendentes" = o que a cliente mandou depois da última resposta: só
  // essas fotos vão anexadas ao modelo; as antigas viram marcador.
  const lastOutboundIndex = rows.reduce(
    (found, row, index) => (row.direction === "outbound" ? index : found),
    -1,
  );
  const pending = rows.slice(lastOutboundIndex + 1).filter((row) => row.direction === "inbound");
  const mediaEnabled = await isBotMediaEnabled(tx);
  if (
    mediaEnabled &&
    pending.some(
      (row) =>
        row.kind === "audio" &&
        isAudioAwaitingTranscription(parseWaMediaMeta(row.mediaMeta), row.createdAt, now),
    )
  ) {
    // O turno enfileirado pela transcrição responde a tudo de uma vez.
    return { skipped: "aguardando_transcricao" };
  }
  const imageUrls = pending
    .filter((row) => row.kind === "image" && row.mediaUrl)
    .slice(-MAX_IMAGES_PER_TURN)
    .map((row) => row.mediaUrl as string);
  const images = mediaEnabled ? await loadTurnImages(provider, imageUrls) : new Map();
  // Fotos recentes para registrar_foto_com_a_peca: as deste turno só se a
  // Lia as viu de fato; as de antes (dentro da janela) valem mesmo sem
  // anexo — "foto → qual peça? → ela responde".
  const recentImages = mediaEnabled
    ? rows
        .filter((row) => row.direction === "inbound" && row.kind === "image" && row.mediaUrl && now.getTime() - row.createdAt.getTime() <= LOOK_PHOTO_WINDOW_MS)
        .filter((row) => !pending.some((p) => p.id === row.id) || images.has(row.mediaUrl as string))
        .slice(-MAX_IMAGES_PER_TURN)
        .map((row) => ({ waMessageId: row.id, mediaUrl: row.mediaUrl as string }))
    : [];

  const messages: BotChatMessage[] = rows.map((message) => {
    if (message.direction !== "inbound") {
      return { role: "assistant" as const, text: historyTextForOutbound(message) };
    }
    const attached = message.mediaUrl ? images.get(message.mediaUrl) : undefined;
    const isPending = pending.some((row) => row.id === message.id);
    return {
      role: "user" as const,
      text: historyTextForInbound({
        kind: message.kind,
        body: message.body,
        mediaMeta: parseWaMediaMeta(message.mediaMeta),
        image: attached ? "attached" : isPending ? "unavailable" : "old",
      }),
      ...(attached ? { images: [attached] } : {}),
    };
  });
  const state = parseBotState(conversation.botState);
  const [memoryLines, purchaseLine, shipmentLine, bridgeLine, followupLines] = await Promise.all([
    loadMemoryLines(tx, conversation.phoneE164),
    purchaseMemoryLineFor(tx, {
      customerId: conversation.customerId,
      phoneE164: conversation.phoneE164,
    }),
    shipmentMemoryLineFor(tx, {
      customerId: conversation.customerId,
      phoneE164: conversation.phoneE164,
    }),
    // Ponte do site recente: estoque ao vivo das peças que ela estava vendo,
    // para a Lia não inventar disponibilidade nem precisar de uma ferramenta.
    state.bridge && isBridgeFresh(state.bridge, now)
      ? bridgeStockLine(tx, state.bridge)
      : Promise.resolve(null),
    followupMemoryLines(tx, conversationId),
  ]);
  const history = assembleHistory(state, messages, {
    lines: [
      ...memoryLines,
      ...(purchaseLine ? [purchaseLine] : []),
      ...(shipmentLine ? [shipmentLine] : []),
      ...(bridgeLine ? [bridgeLine] : []),
      ...followupLines,
    ],
    now,
  });

  const lastInboundAt = rows.filter((row) => row.direction === "inbound").at(-1)?.createdAt ?? null;
  return {
    history,
    recentImages,
    media: { images: images.size, audios: pending.filter((row) => row.kind === "audio").length },
    lastInboundAt,
    pendingInbound: pending.length,
  };
}

// ---------------------------------------------------------------------------
// deliverBotTurn — a entrega do turno: mídia antes do texto, até 3 balões,
// cortesia pós-transferência; cada envio com dedupe determinístico derivado
// de `dedupeBase` (id da inbound no turno reativo, id do retorno no
// proativo) — o retry da fila nunca duplica nada.
// ---------------------------------------------------------------------------

export async function deliverBotTurn(
  tx: DbOrTx,
  provider: MessagingProvider,
  input: {
    conversation: Pick<TurnConversation, "phoneE164" | "customerId">;
    dedupeBase: string;
    attachments: readonly BotAttachment[];
    bubbles: readonly string[];
    handedOff: boolean;
  },
): Promise<{ replied: boolean; firstWaMessageId: string | null }> {
  const { conversation, dedupeBase, attachments, bubbles } = input;
  const replyDedupeKey = `wa.bot_reply:${dedupeBase}`;
  const customerRef = conversation.customerId ? { customerId: conversation.customerId } : {};
  // Lista e foto ANTES do texto (o cliente vê e depois o convite); a voz da
  // curadora DEPOIS ("segue a voz dela" e aí o áudio) — assim um texto que
  // falha e aborta o turno nunca deixa uma mensagem de voz já entregue para o
  // retry repetir. Cada mídia tem dedupe determinístico por índice; falha é
  // melhor esforço.
  const sendAttachment = async (attachment: BotAttachment, index: number): Promise<void> => {
    const mediaDedupeKey = `wa.bot_media:${dedupeBase}:${index}`;
    try {
      if (attachment.kind === "option_list") {
        await sendMediaMessage(tx, provider, {
          kind: "option_list",
          body: attachment.message,
          optionList: {
            title: attachment.title,
            buttonLabel: attachment.buttonLabel,
            options: attachment.options,
          },
          phoneE164: conversation.phoneE164,
          ...customerRef,
          dedupeKey: mediaDedupeKey,
          requireOptIn: false,
        });
      } else if (attachment.kind === "audio") {
        await sendMediaMessage(tx, provider, {
          kind: "audio",
          audioUrl: attachment.audioUrl,
          body: attachment.body,
          phoneE164: conversation.phoneE164,
          ...customerRef,
          dedupeKey: mediaDedupeKey,
          requireOptIn: false,
        });
      } else {
        await sendMediaMessage(tx, provider, {
          kind: "image",
          imageUrl: attachment.imageUrl,
          body: attachment.caption,
          phoneE164: conversation.phoneE164,
          ...customerRef,
          dedupeKey: mediaDedupeKey,
          requireOptIn: false,
        });
      }
    } catch (error) {
      console.warn(
        `[wa-bot] Falha ao enviar mídia ${mediaDedupeKey}; o texto da IA segue mesmo assim.`,
        error,
      );
    }
  };
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.kind !== "audio") await sendAttachment(attachment, index);
  }

  let replied = false;
  let firstWaMessageId: string | null = null;
  for (const [index, bubble] of bubbles.entries()) {
    const sent = await sendTemplateMessage(tx, provider, {
      bodyOverride: truncateForWhatsApp(bubble),
      phoneE164: conversation.phoneE164,
      ...customerRef,
      dedupeKey: index === 0 ? replyDedupeKey : `${replyDedupeKey}:${index}`,
      requireOptIn: false,
    });
    if ("sent" in sent) {
      replied = true;
      firstWaMessageId ??= sent.waMessageId;
    }
  }

  for (const [index, attachment] of attachments.entries()) {
    if (attachment.kind === "audio") await sendAttachment(attachment, index);
  }

  if (input.handedOff) {
    // Cortesia pós-transferência, com dedupe próprio (também idempotente).
    await sendTemplateMessage(tx, provider, {
      bodyOverride: HANDOFF_COURTESY_REPLY,
      phoneE164: conversation.phoneE164,
      ...customerRef,
      dedupeKey: `wa.bot_handoff_notice:${dedupeBase}`,
      requireOptIn: false,
    });
  }
  return { replied, firstWaMessageId };
}

// ---------------------------------------------------------------------------
// runBotTurn — um turno completo sobre a conversa, chamado pelo handler
// 'wa.bot_turn' da fila. FOR UPDATE serializa turnos concorrentes da mesma
// conversa; a idempotência REAL da resposta vem do dedupe derivado do id da
// última wa_message inbound (retry da fila nunca duplica resposta).
// ---------------------------------------------------------------------------

export const BOT_TURN_EVENT = "wa.bot_turn";

export async function runBotTurn(
  db: DbOrTx,
  assistant: SalesAssistant,
  provider: MessagingProvider,
  input: { conversationId: string; attempt?: number },
  deps: { cards?: BotCardDeps } = {},
): Promise<RunBotTurnResult> {
  const { conversationId } = input;
  // `attempt` = tentativas ANTERIORES da fila (0 na primeira).
  const lastAttempt = (input.attempt ?? 0) + 1 >= getRetryPolicy(BOT_TURN_EVENT).maxAttempts;

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, conversationId))
      .for("update");

    if (!conversation) return { skipped: "conversa_inexistente" };
    if (conversation.status === "human") return { skipped: "atendimento_humano" };
    if (conversation.status === "closed") return { skipped: "conversa_fechada" };
    if (
      conversation.botDisabledUntil !== null &&
      conversation.botDisabledUntil.getTime() > Date.now()
    ) {
      return { skipped: "bot_silenciado" };
    }
    if (!(await isBotEnabled(tx))) return { skipped: "desabilitado" };

    const [lastInbound] = await tx
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.conversationId, conversationId),
          eq(waMessages.direction, "inbound"),
        ),
      )
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(1);
    if (!lastInbound) return { skipped: "sem_mensagem_inbound" };

    const now = new Date();
    const loaded = await loadTurnHistory(tx, provider, { conversation, now });
    if ("skipped" in loaded) return loaded;
    const { history, recentImages, media } = loaded;
    // Cada mensagem dela enfileira um turno, mas o primeiro que roda responde
    // a tudo o que chegou até ali: os seguintes acham tudo respondido e não
    // rodam o modelo de novo (era isso que estourava o limite por minuto da
    // API e mandava a conversa para a equipe à toa).
    if (loaded.pendingInbound === 0) return { skipped: "ja_respondida" };

    const { system, model } = await buildBotPromptBundle(tx);
    // Copiloto (loja ou só esta conversa): a Lia pensa, a dona manda.
    const copilot = (await resolveConversationBotMode(tx, conversation)) === "copilot";
    if (copilot) {
      // Reentrada da fila (mesma inbound): a sugestão já existe — nada de
      // rodar o modelo e as ferramentas de estado de novo.
      const existing = await findSuggestionByInbound(tx, lastInbound.id);
      if (existing) return { suggested: true, suggestionId: existing };
    }

    // Mídia emitida pelas ferramentas do turno (lista tocável, foto).
    const attachments: BotAttachment[] = [];
    const executeTool = buildToolExecutor(tx, {
      conversationId,
      phoneE164: conversation.phoneE164,
      customerId: conversation.customerId,
      lastInboundId: lastInbound.id,
      onAttachment: (attachment) => attachments.push(attachment),
      cepLookup: getCepLookup(),
      recentImages,
      copilot,
      ...(deps.cards ? { cards: deps.cards } : {}),
    });

    const replyDedupeKey = `wa.bot_reply:${lastInbound.id}`;
    const customerRef = conversation.customerId
      ? { customerId: conversation.customerId }
      : {};

    let turn: AssistantTurn;
    const startedAt = Date.now();
    try {
      turn = await assistant.respondTurn({ system, history, model, executeTool });
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        // Falha passageira (limite por minuto, 5xx, rede): relança — a fila
        // tenta de novo com espera, a transação desfaz o que as ferramentas
        // anotaram e nada saiu para a cliente. Só na última tentativa (ou
        // em falha que não melhora sozinha: chave, crédito, modelo) vem o
        // plano B.
        if (error.retryable && !lastAttempt) throw error;
        const reason = `Assistente de IA indisponível (${error.reason})`;
        await tx.insert(auditLog).values({
          actorType: "system",
          actorId: null,
          action: "wa.bot_turn_failed",
          entityType: "wa_conversation",
          entityId: conversationId,
          after: {
            inboundId: lastInbound.id,
            attempt: (input.attempt ?? 0) + 1,
            status: error.status ?? null,
            code: error.code ?? null,
            reason: error.reason,
          },
        });
        // Plano B: avisa o cliente, transfere para humano (audit + aviso ao
        // dono) e encerra o turno sem propagar — o evento da fila conclui.
        // Em copiloto nada sai para a cliente por conta própria: só a transferência.
        if (!copilot) {
          await sendTemplateMessage(tx, provider, {
            bodyOverride: BOT_UNAVAILABLE_REPLY,
            phoneE164: conversation.phoneE164,
            ...customerRef,
            dedupeKey: replyDedupeKey,
            requireOptIn: false,
          });
        }
        await handOffToHuman(
          tx,
          {
            conversationId,
            phoneE164: conversation.phoneE164,
            lastInboundId: lastInbound.id,
          },
          reason,
        );
        return { replied: true, handedOff: true };
      }
      throw error;
    }

    const bubbles = turn.reply === null ? [] : splitBotReply(turn.reply);
    // Trilha do turno para o painel e para o custo por conversa: quais
    // ferramentas rodaram, tokens gastos, tempo e se transferiu. Nunca guarda
    // o texto (ele já está em wa_messages).
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.bot_turn",
      entityType: "wa_conversation",
      entityId: conversationId,
      after: {
        inboundId: lastInbound.id,
        mode: copilot ? "copilot" : "autonomous",
        model,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        handedOff: turn.handedOff,
        attachments: attachments.map((attachment) => attachment.kind),
        bubbles: bubbles.length,
        durationMs: Date.now() - startedAt,
        // Só contagens: a foto nunca é guardada.
        media,
      },
    });

    if (copilot) {
      // A Lia pediu ajuda (recusa do modelo, estouro): a dona assume de vez —
      // é o que ela faria sozinha, só que sem texto para a cliente.
      if (turn.handedOff) {
        await handOffToHuman(tx, { conversationId, phoneE164: conversation.phoneE164, lastInboundId: lastInbound.id }, "A vendedora pediu ajuda (copiloto)");
        return { replied: false, handedOff: true };
      }
      const [customer] = conversation.customerId
        ? await tx.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, conversation.customerId)).limit(1)
        : [];
      if (bubbles.length === 0 && attachments.length === 0) {
        // Sem sugestão: a antiga (de outra mensagem) perde o sentido e a
        // cliente não pode ficar no vácuo sem ninguém saber.
        await supersedePendingSuggestions(tx, conversationId, now);
        await enqueueSuggestionNotice(tx, { conversationId, phoneE164: conversation.phoneE164, customerName: customer?.fullName ?? null, now, empty: true });
        return { replied: false, handedOff: false };
      }
      const { suggestionId, created } = await createSuggestion(tx, {
        conversationId,
        inboundMessageId: lastInbound.id,
        bubbles,
        attachments,
        toolCalls: turn.toolCalls,
        now,
      });
      if (created) await enqueueSuggestionNotice(tx, { conversationId, phoneE164: conversation.phoneE164, customerName: customer?.fullName ?? null, now });
      return { suggested: true, suggestionId };
    }

    const { replied } = await deliverBotTurn(tx, provider, {
      conversation,
      dedupeBase: lastInbound.id,
      attachments,
      bubbles,
      handedOff: turn.handedOff,
    });
    return { replied, handedOff: turn.handedOff };
  });
}

// ---------------------------------------------------------------------------
// runScheduledBotTurn — o turno PROATIVO (retorno combinado / retomada):
// chamado pelo handler 'wa.bot_followup' quando `due_at` vence. Mesmos
// bloqueios do turno reativo (FOR UPDATE, humano, fechada, silenciada,
// desligada), mais: só na janela de envio (fora dela re-enfileira datado),
// só se a cliente não voltou por conta depois do combinado, só sem SAIR.
// A "fala" que abre o turno é sintética e vira um marcador no histórico.
// ---------------------------------------------------------------------------

export type RunScheduledBotTurnResult =
  | { sent: true; followupId: string; replied: boolean; suggestionId?: string }
  | { skipped: string; followupId: string };

export async function runScheduledBotTurn(
  db: DbOrTx,
  assistant: SalesAssistant,
  provider: MessagingProvider,
  input: { followupId: string; now?: Date; attempt?: number; deadlineAt?: Date | null },
  deps: { cards?: BotCardDeps } = {},
): Promise<RunScheduledBotTurnResult> {
  const { followupId } = input;
  const now = input.now ?? new Date();
  // `attempt` = tentativas ANTERIORES (0 na primeira), como no wa.transcribe.
  const lastAttempt = (input.attempt ?? 0) + 1 >= getRetryPolicy(BOT_FOLLOWUP_EVENT).maxAttempts;

  return db.transaction(async (tx) => {
    // Ordem dos locks igual à do turno reativo — a CONVERSA primeiro (o
    // reativo trava a conversa e depois mexe em wa_followups); só então o
    // retorno. Senão os dois turnos se travam em cruz e um deles cai.
    const [pointer] = await tx.select({ conversationId: waFollowups.conversationId }).from(waFollowups).where(eq(waFollowups.id, followupId)).limit(1);
    if (!pointer) return { skipped: "inexistente", followupId };
    const [conversation] = await tx.select().from(waConversations).where(eq(waConversations.id, pointer.conversationId)).for("update");
    const [followup] = await tx.select().from(waFollowups).where(eq(waFollowups.id, followupId)).for("update");
    if (!followup) return { skipped: "inexistente", followupId };
    if (followup.status !== "scheduled") return { skipped: `status_${followup.status}`, followupId };

    const finish = async (status: "canceled" | "superseded" | "skipped", reason: string) => {
      await tx
        .update(waFollowups)
        .set({ status, canceledAt: now, canceledReason: reason, updatedAt: now })
        .where(eq(waFollowups.id, followupId));
      return { skipped: reason, followupId } as const;
    };

    if (!conversation) return finish("canceled", "conversa_inexistente");
    if (conversation.status === "human") return finish("canceled", "conversa_humana");
    if (conversation.status === "closed") return finish("canceled", "conversa_fechada");
    if (conversation.botDisabledUntil !== null && conversation.botDisabledUntil.getTime() > now.getTime()) {
      return finish("canceled", "bot_silenciado");
    }
    if (!(await isBotEnabled(tx))) return finish("canceled", "bot_desligado");
    if (!(await isWaEnabled(tx))) return finish("canceled", "whatsapp_desligado");
    // (SAIR cancela o combinado na hora, no webhook — com ou sem cadastro.)
    // Chegou tarde demais (fila parada, modelo fora do ar por horas): "como
    // combinamos" no dia seguinte soa errado — não chama.
    if (isFollowupTooLate({ dueAt: followup.dueAt, now })) return finish("skipped", "atrasado");

    // Fora da janela (retry tardio, madrugada): volta para a abertura, uma
    // vez por dia; o status continua agendado.
    const policy = await loadSendPolicy(tx);
    if (!isWithinSendWindow(now, policy.window)) {
      await enqueueOutboxEvent(tx, {
        eventType: "wa.bot_followup",
        dedupeKey: `wa.bot_followup:${followupId}:${spDayKey(now)}`,
        aggregateType: "wa_conversation",
        aggregateId: conversation.id,
        payload: { followupId },
        nextAttemptAt: nextSendWindowStart(now, policy.window),
      });
      return { skipped: "fora_da_janela", followupId };
    }

    // Ela voltou por conta depois do combinado? Antes de qualquer custo.
    const [lastInbound] = await tx
      .select({ createdAt: waMessages.createdAt })
      .from(waMessages)
      .where(and(eq(waMessages.conversationId, conversation.id), eq(waMessages.direction, "inbound")))
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(1);
    if (followup.kind === "idle_cart") {
      // Sacola parada: na hora de mandar, tudo de novo (zero carência,
      // sacola, pedido, opt-in, recurso ligado) — nada de "ficou parada" para
      // quem comprou ontem à noite.
      const invalid = await idleCartStillValid(tx, { conversation, followupCreatedAt: followup.createdAt, lastInboundAt: lastInbound?.createdAt ?? null });
      if (invalid) return finish(invalid === "superada" ? "superseded" : "canceled", invalid);
    } else if (isFollowupSuperseded({ createdAt: followup.createdAt, lastInboundAt: lastInbound?.createdAt ?? null })) {
      return finish("superseded", "superada");
    }
    const loaded = await loadTurnHistory(tx, provider, { conversation, now });
    if ("skipped" in loaded) {
      // Áudio dela ainda transcrevendo: o turno da transcrição vai responder;
      // tenta o retorno de novo daqui a pouco (política da fila) — na última
      // tentativa desiste em vez de ficar agendado para sempre.
      if (lastAttempt) return finish("skipped", "superada");
      throw new Error(`Retorno ${followupId}: ${loaded.skipped} — tentando de novo.`);
    }

    const kind = followup.kind as FollowupKind;
    const synthetic = renderFollowupPrompt({ kind, reason: followup.reason, dueAt: followup.dueAt });
    const history: BotChatMessage[] = [...loaded.history, { role: "user", text: synthetic }];
    const { system, model } = await buildBotPromptBundle(tx);

    const copilot = (await resolveConversationBotMode(tx, conversation)) === "copilot";
    const attachments: BotAttachment[] = [];
    const executeTool = buildToolExecutor(tx, {
      conversationId: conversation.id,
      phoneE164: conversation.phoneE164,
      customerId: conversation.customerId,
      // O id do retorno é a base dos dedupes do turno (não há inbound).
      lastInboundId: followupId,
      onAttachment: (attachment) => attachments.push(attachment),
      cepLookup: getCepLookup(),
      recentImages: loaded.recentImages,
      now,
      proactive: true,
      copilot,
      ...(deps.cards ? { cards: deps.cards } : {}),
    });

    const startedAt = Date.now();
    // Modelo fora do ar: relança — a política da fila tenta de novo e o
    // combinado continua agendado (nada de plano B proativo). Na última
    // tentativa, registra e desiste: nada de retorno "agendado" para sempre.
    let turn: AssistantTurn;
    try {
      turn = await assistant.respondTurn({ system, history, model, executeTool });
    } catch (error) {
      if (lastAttempt) return finish("skipped", "modelo_indisponivel");
      throw error;
    }
    const bubbles = turn.reply === null ? [] : splitBotReply(turn.reply);
    if (bubbles.length === 0 && attachments.length === 0) return finish("skipped", "sem_resposta");

    // Nada de fala sintética gravada: a resposta sai com dedupe
    // `wa.bot_reply:followup:<id>` e o histórico/painel a marcam como
    // "você chamou como combinado" (core/whatsapp/origin.ts).
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.bot_turn",
      entityType: "wa_conversation",
      entityId: conversation.id,
      after: {
        followupId,
        kind,
        model,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        handedOff: turn.handedOff,
        attachments: attachments.map((attachment) => attachment.kind),
        bubbles: bubbles.length,
        durationMs: Date.now() - startedAt,
        media: loaded.media,
      },
    });

    if (copilot) {
      // O retorno vira sugestão: a dona manda (ou não) — o combinado está cumprido pela Lia.
      const { suggestionId, created } = await createSuggestion(tx, { conversationId: conversation.id, followupId, bubbles, attachments, toolCalls: turn.toolCalls, now });
      const [customer] = conversation.customerId
        ? await tx.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, conversation.customerId)).limit(1)
        : [];
      if (created) await enqueueSuggestionNotice(tx, { conversationId: conversation.id, phoneE164: conversation.phoneE164, customerName: customer?.fullName ?? null, now });
      await tx.update(waFollowups).set({ status: "sent", sentAt: now, updatedAt: now }).where(eq(waFollowups.id, followupId));
      return { sent: true, followupId, replied: false, suggestionId };
    }

    const delivered = await deliverBotTurn(tx, provider, {
      conversation,
      dedupeBase: `followup:${followupId}`,
      attachments,
      bubbles,
      handedOff: turn.handedOff,
    });
    // Nada saiu de fato (número sem WhatsApp, só anexos que falharam): o
    // combinado não foi cumprido e o painel diz por quê.
    if (!delivered.replied) return finish("skipped", "nao_enviado");
    await tx
      .update(waFollowups)
      .set({ status: "sent", sentAt: now, sentWaMessageId: delivered.firstWaMessageId, updatedAt: now })
      .where(eq(waFollowups.id, followupId));
    return { sent: true, followupId, replied: true };
  });
}

/** Carência depois do "sim": uma mensagem logo em seguida não cancela o combinado. */
export { FOLLOWUP_GRACE_MINUTES };
