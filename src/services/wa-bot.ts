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
import { deriveWaMessageOrigin } from "@/core/whatsapp/origin";
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
import { execRegistrarFotoComAPeca, execRetirarMinhaFoto } from "./bot/looks";
import { LOOK_PHOTO_WINDOW_MS } from "./customer-looks";
import { execAnotar, execAtualizarCartela, loadMemoryLines } from "./bot/style";

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
}): string {
  const origin = deriveWaMessageOrigin({
    direction: "outbound",
    dedupeKey: input.dedupeKey,
    templateKey: input.templateKey,
  });
  const text = historyTextFor(input.kind, input.body);
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
    emitCard: makeCardEmitter(db, baseCtx),
  };
  return async (name, rawInput) => {
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
      case "registrar_foto_com_a_peca":
        return execRegistrarFotoComAPeca(db, ctx, parsed.data as BotToolInputs["registrar_foto_com_a_peca"]);
      case "retirar_minha_foto":
        return execRetirarMinhaFoto(db, ctx);
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
// runBotTurn — um turno completo sobre a conversa, chamado pelo handler
// 'wa.bot_turn' da fila. FOR UPDATE serializa turnos concorrentes da mesma
// conversa; a idempotência REAL da resposta vem do dedupe derivado do id da
// última wa_message inbound (retry da fila nunca duplica resposta).
// ---------------------------------------------------------------------------

export async function runBotTurn(
  db: DbOrTx,
  assistant: SalesAssistant,
  provider: MessagingProvider,
  input: { conversationId: string },
  deps: { cards?: BotCardDeps } = {},
): Promise<RunBotTurnResult> {
  const { conversationId } = input;

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
    const now = new Date();
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
    const [memoryLines, purchaseLine, shipmentLine, bridgeLine] = await Promise.all([
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
    ]);
    const history = assembleHistory(state, messages, {
      lines: [
        ...memoryLines,
        ...(purchaseLine ? [purchaseLine] : []),
        ...(shipmentLine ? [shipmentLine] : []),
        ...(bridgeLine ? [bridgeLine] : []),
      ],
      now,
    });

    const { system, model } = await buildBotPromptBundle(tx);

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
        // Plano B: avisa o cliente, transfere para humano (audit + aviso ao
        // dono) e encerra o turno sem propagar — o evento da fila conclui.
        await sendTemplateMessage(tx, provider, {
          bodyOverride: BOT_UNAVAILABLE_REPLY,
          phoneE164: conversation.phoneE164,
          ...customerRef,
          dedupeKey: replyDedupeKey,
          requireOptIn: false,
        });
        await handOffToHuman(
          tx,
          {
            conversationId,
            phoneE164: conversation.phoneE164,
            lastInboundId: lastInbound.id,
          },
          "Assistente de IA indisponível",
        );
        return { replied: true, handedOff: true };
      }
      throw error;
    }

    // Mídia ANTES do texto (o cliente vê a lista/foto e depois o convite),
    // cada uma com dedupe determinístico por índice; falha é melhor esforço.
    for (const [index, attachment] of attachments.entries()) {
      const mediaDedupeKey = `wa.bot_media:${lastInbound.id}:${index}`;
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
    }

    // Resposta em até 3 balões (o modelo separa com '---'), o primeiro com o
    // dedupe histórico e os demais com sufixo — retry nunca duplica nenhum.
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
        model,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        handedOff: turn.handedOff,
        attachments: attachments.map((attachment) => attachment.kind),
        bubbles: bubbles.length,
        durationMs: Date.now() - startedAt,
        // Só contagens: a foto nunca é guardada.
        media: {
          images: images.size,
          audios: pending.filter((row) => row.kind === "audio").length,
        },
      },
    });

    let replied = false;
    for (const [index, bubble] of bubbles.entries()) {
      const sent = await sendTemplateMessage(tx, provider, {
        bodyOverride: truncateForWhatsApp(bubble),
        phoneE164: conversation.phoneE164,
        ...customerRef,
        dedupeKey: index === 0 ? replyDedupeKey : `${replyDedupeKey}:${index}`,
        requireOptIn: false,
      });
      if ("sent" in sent) replied = true;
    }

    if (turn.handedOff) {
      // Cortesia pós-transferência, com dedupe próprio (também idempotente).
      await sendTemplateMessage(tx, provider, {
        bodyOverride: HANDOFF_COURTESY_REPLY,
        phoneE164: conversation.phoneE164,
        ...customerRef,
        dedupeKey: `wa.bot_handoff_notice:${lastInbound.id}`,
        requireOptIn: false,
      });
    }

    return { replied, handedOff: turn.handedOff };
  });
}
