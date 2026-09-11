// Peças comuns dos executores da vendedora: tipos, constantes, caderninho (bot_state) e emissor de cartões.
import { eq } from "drizzle-orm";
import type { CepLookup } from "@/adapters/cep";
import type { FileStorage } from "@/adapters/storage";
import { parseBotState, type BotState } from "@/core/bot/memory";
import { OPTION_LIST_MAX_OPTIONS } from "@/core/bot/option-list";
import { waConversations } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { formatCentsBRL } from "@/lib/money";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import {
  findCachedBotCard,
  isBotCardsEnabled,
  publishBotCard,
  type CardProductRef,
  type CardRenderer,
} from "@/services/bot-cards";
import { getSettingsMap } from "@/services/settings";

export const DEFAULT_BOT_MODEL = "claude-sonnet-5";

export const DEFAULT_STORE_NAME = STORE_NAME_DEFAULT;

// 40 mensagens: uma compra com lista + foto + CEP + frete + cadastro passa
// fácil de 20, e a peça escolhida no começo saía da janela.
export const HISTORY_LIMIT = 40;

export const PAGE_SIZE = OPTION_LIST_MAX_OPTIONS;

export const DESCRIPTION_MAX_CHARS = 700;

// Pix manual tem ritmo humano (dono confere o banco): o prazo de reserva de
// 2h expiraria DEPOIS de o cliente pagar — estendemos para 24h quando menor.
export const PIX_MANUAL_TTL_HOURS = 24;

export const BOT_UNAVAILABLE_REPLY =
  "Nosso atendimento automático está indisponível — já chamei a equipe 😉";

export const HANDOFF_COURTESY_REPLY =
  "Alguém da equipe vai te responder por aqui em breve! 🙋";

/**
 * Mídia que uma ferramenta quer enviar ao cliente NESTE turno (lista tocável
 * ou foto). A ferramenta apenas EMITE via ctx.onAttachment; quem envia de fato
 * (com dedupe e melhor esforço) é o runBotTurn, antes do texto da IA.
 */
export type BotAttachment =
  | {
      kind: "option_list";
      message: string;
      title: string;
      buttonLabel: string;
      options: { id: string; title: string; description?: string }[];
    }
  | { kind: "image"; imageUrl: string; caption: string };

/** O que o turno precisa para desenhar o cartão editorial (vitrine/look). */
export type BotCardDeps = { storage: FileStorage; render: CardRenderer };

/**
 * Teto para desenhar um cartão DENTRO do turno — só no ensaio (dryRun), onde
 * ninguém está no WhatsApp esperando. Na conversa real, cartão fora do cache
 * vai para a fila e chega logo depois do texto.
 */
export const CARD_TIMEOUT_MS = 12_000;

export type BotExecutorContext = {
  conversationId: string;
  phoneE164: string;
  customerId: string | null;
  /** Sem isto (ou com bot_cards_enabled=false) a vendedora manda só a lista. */
  cards?: BotCardDeps;
  /**
   * Id da última wa_message inbound do turno — base dos dedupes das
   * ferramentas com efeito externo (enviar_chave_pix, avisar_dono): o retry
   * do evento da fila reexecuta o turno inteiro e NÃO pode duplicar avisos.
   */
  lastInboundId: string;
  onAttachment?: (attachment: BotAttachment) => void;
  /**
   * Ensaio (playground do painel): nada com efeito externo ou de escrita
   * acontece — criar_pedido, enviar_chave_pix, avisar_dono e transferir
   * respondem um texto explicando que estão desligados no ensaio.
   */
  dryRun?: boolean;
  /**
   * Caderninho em memória do ensaio: no dryRun nada é gravado, mas as
   * ferramentas do MESMO turno se enxergam (adicionar_a_sacola → validar_cupom
   * → cotar_frete). buildToolExecutor cria; os executores só usam via
   * readBotState/updateBotState.
   */
  stateOverlay?: { current: BotState | null };
  /** Consulta de CEP: cotar_frete devolve também rua/bairro/cidade/UF. */
  cepLookup?: CepLookup;
};

export type RunBotTurnResult =
  | { replied: boolean; handedOff: boolean }
  | { skipped: string };

export type CardRequest = {
  kind: "catalog" | "look";
  title: string;
  eyebrow: string;
  items: CardProductRef[];
  caption: string;
};

/**
 * "sent" = anexo de imagem emitido no turno (cache); "queued" = vai pela fila
 * e chega logo depois do texto; false = sem cartão.
 */
export type CardEmitter = (request: CardRequest) => Promise<"sent" | "queued" | false>;

export type ExecutorCtx = BotExecutorContext & { emitCard: CardEmitter };

/**
 * Um cartão por turno, melhor esforço: cache → anexo na hora; sem cache, na
 * conversa real enfileira `wa.card_render` (o texto sai sem esperar o render
 * frio) e no ensaio desenha inline com teto de tempo. Falha = sem cartão.
 */
export function makeCardEmitter(db: DbOrTx, ctx: BotExecutorContext): CardEmitter {
  let emitted = false;
  return async (request) => {
    if (emitted || !ctx.cards || !ctx.onAttachment) return false;
    if (!(await isBotCardsEnabled(db))) return false;
    emitted = true;
    const { storage, render } = ctx.cards;
    const input = {
      kind: request.kind,
      storeName: await storeNameFor(db),
      eyebrow: request.eyebrow,
      title: request.title,
      items: request.items,
    };
    try {
      const cached = await findCachedBotCard(db, storage, input);
      if (cached) {
        ctx.onAttachment({ kind: "image", imageUrl: cached.url, caption: request.caption });
        return "sent";
      }
      if (!ctx.dryRun) {
        await enqueueOutboxEvent(db, {
          eventType: "wa.card_render",
          dedupeKey: `wa.card:${ctx.lastInboundId}`,
          aggregateType: "wa_conversation",
          aggregateId: ctx.conversationId,
          payload: {
            conversationId: ctx.conversationId,
            phoneE164: ctx.phoneE164,
            customerId: ctx.customerId,
            lastInboundId: ctx.lastInboundId,
            caption: request.caption,
            request: input,
          },
        });
        return "queued";
      }
      const card = await Promise.race([
        publishBotCard(db, storage, render, input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("cartão: tempo esgotado")), CARD_TIMEOUT_MS),
        ),
      ]);
      ctx.onAttachment({ kind: "image", imageUrl: card.url, caption: request.caption });
      return "sent";
    } catch (error) {
      console.warn("[wa-bot] cartão editorial não enviado:", error instanceof Error ? error.message : error);
      return false;
    }
  };
}

export async function storeNameFor(db: DbOrTx): Promise<string> {
  const map = await getSettingsMap(db, ["store_name"]);
  return typeof map["store_name"] === "string" && map["store_name"].trim() !== ""
    ? map["store_name"].trim()
    : STORE_NAME_DEFAULT;
}

// ---------------------------------------------------------------------------
// Helpers de estado da conversa (o caderninho)
// ---------------------------------------------------------------------------

export async function loadBotState(db: DbOrTx, conversationId: string): Promise<BotState> {
  const [row] = await db
    .select({ botState: waConversations.botState })
    .from(waConversations)
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  return parseBotState(row?.botState);
}

export async function saveBotState(
  db: DbOrTx,
  conversationId: string,
  state: BotState,
): Promise<void> {
  await db
    .update(waConversations)
    .set({ botState: state, updatedAt: new Date() })
    .where(eq(waConversations.id, conversationId));
}

/** O caderninho como o executor deve ler: no ensaio, o overlay do turno; na conversa real, o banco. */
export async function readBotState(
  db: DbOrTx,
  ctx: Pick<BotExecutorContext, "conversationId" | "stateOverlay">,
): Promise<BotState> {
  if (ctx.stateOverlay) {
    if (ctx.stateOverlay.current === null) {
      ctx.stateOverlay.current = await loadBotState(db, ctx.conversationId);
    }
    return ctx.stateOverlay.current;
  }
  return loadBotState(db, ctx.conversationId);
}

/** Lê, aplica a mudança e grava — o padrão de todo executor que lembra algo. */
export async function updateBotState(
  db: DbOrTx,
  ctx: BotExecutorContext,
  change: (state: BotState) => BotState,
): Promise<BotState> {
  const current = await readBotState(db, ctx);
  const next = change(current);
  if (ctx.stateOverlay) {
    ctx.stateOverlay.current = next;
  } else if (!ctx.dryRun) {
    await saveBotState(db, ctx.conversationId, next);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Contrato dos executores: cada ferramenta devolve um bloco pt-BR pronto
// ---------------------------------------------------------------------------

export type ToolResult = { ok: boolean; text: string; endsTurn?: boolean };

export const DRY_RUN_TEXT =
  "[Ensaio: esta ação fica desligada no teste do painel. Responda à cliente como se tivesse funcionado, sem inventar números.]";

export function formatDeliveryDays(min: number, max: number): string {
  return min === max ? `${min} dias úteis` : `${min} a ${max} dias úteis`;
}

export function formatPriceRange(fromCents: number, toCents: number): string {
  return fromCents === toCents
    ? formatCentsBRL(fromCents)
    : `a partir de ${formatCentsBRL(fromCents)}`;
}
