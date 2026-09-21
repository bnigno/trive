import { getMailboxProvider, isMailboxConfigured } from "@/adapters/mailbox";
import { getPaymentGateway } from "@/adapters/mercadopago";
import { getFileStorage } from "@/adapters/storage";
import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { inngest } from "@/inngest/client";
import { enqueueOutboxEvent, kickOutbox } from "@/queue/enqueue";
import { runOutboxKick } from "@/queue/kick";
import { drainOutbox, type DrainOutboxResult } from "@/queue/worker";
import { enqueueDailyDigest } from "@/services/daily-digest";
import { pollEmailInbox } from "@/services/email-inbox";
import { reconcilePendingMpOrders } from "@/services/payments";
import { dispatchDueDrops } from "@/services/drops";
import { expireOverdueHolds, remindExpiringHolds } from "@/services/stock-holds";
import { closeStaleDeliveryRuns, purgeOldDeliveryPositions } from "@/services/delivery-runs";
import { expireOverdueReservations } from "@/services/store-orders";
import { isWaEnabled, recoverUnpaidOrders } from "@/services/wa-messaging";
import { scheduleIdleCartFollowups } from "@/services/wa-followups";
import { checkSessionAndAlert } from "@/services/wa-session";
import { checkInboundGapsAndAlert } from "@/services/wa-watchdog";
import { syncAllGroups } from "@/services/wa-groups";
import { alertFunctionFailure } from "@/services/system-alerts";
import { autoReturnIdleHumanConversations } from "@/services/wa-conversations";

const SWEEP_BATCH_LIMIT = 25;
const SWEEP_MAX_BATCHES = 10;
// Orçamento de tempo por invocação, abaixo do maxDuration (60 s) da rota
// /api/inngest: um lote de comprovantes (1–3 s cada) não pode derrubar a
// função no meio de um evento. O que sobrar sai no sweep seguinte (1 min).
const SWEEP_BUDGET_MS = 40_000;

export const outboxSweep = inngest.createFunction(
  { id: "outbox-sweep", triggers: [{ cron: "* * * * *" }] },
  async () => {
    const db = getDb();
    const startedAt = Date.now();
    const totals: DrainOutboxResult & { budgetExceeded: boolean } = {
      recovered: 0,
      claimed: 0,
      done: 0,
      failed: 0,
      dead: 0,
      released: 0,
      releasedIds: [],
      failedIds: [],
      budgetExceeded: false,
    };
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > SWEEP_BUDGET_MS) {
        totals.budgetExceeded = true;
        break;
      }
      // O lote também respeita o que sobrou do orçamento: um evento demorado
      // (pré-desenho de uma peça com muitas cores) não arrasta os irmãos.
      const result = await drainOutbox(db, {
        limit: SWEEP_BATCH_LIMIT,
        budgetMs: SWEEP_BUDGET_MS - elapsed,
        source: "cron",
      });
      totals.recovered += result.recovered;
      totals.claimed += result.claimed;
      totals.done += result.done;
      totals.failed += result.failed;
      totals.dead += result.dead;
      totals.released += result.released;
      totals.releasedIds.push(...result.releasedIds);
      totals.failedIds.push(...result.failedIds);
      if (result.claimed === 0 || result.released > 0) break;
    }
    // Turno da Lia devolvido por não caber no que sobrava: outra invocação
    // inteira agora, em vez de esperar o próximo minuto.
    for (const id of totals.releasedIds) await kickOutbox(id, { rekick: true });
    return totals;
  },
);

// Kick: drena agora. Com o id da linha, espera ela aparecer (quem enfileirou
// pode ainda estar na transação) — ver src/queue/kick.ts.
export const outboxKick = inngest.createFunction(
  { id: "outbox-kick", triggers: [{ event: "outbox/event.enqueued" }] },
  async ({ event }) => {
    const data = (event.data ?? {}) as { outboxEventId?: unknown; rekick?: unknown };
    const outboxEventId = typeof data.outboxEventId === "string" ? data.outboxEventId : undefined;
    return runOutboxKick(getDb(), { outboxEventId, rekick: data.rekick === true, source: "kick" });
  },
);

// Expira reservas de estoque vencidas (pedidos da loja aguardando pagamento
// manual além do prazo). A página pública também expira lazy; o cron garante
// que a reserva volte ao estoque mesmo sem ninguém abrir a página.
export const reservationExpiry = inngest.createFunction(
  { id: "reservation-expiry", triggers: [{ cron: "*/10 * * * *" }] },
  async () => {
    return expireOverdueReservations(getDb());
  },
);

// Reserva gentil: devolve ao estoque as reservas vencidas e manda o lembrete
// único 2 h antes de vencer (só com opt-in; nunca lança por skip).
export const holdExpiry = inngest.createFunction(
  { id: "hold-expiry", triggers: [{ cron: "*/10 * * * *" }] },
  async () => {
    const db = getDb();
    const expired = await expireOverdueHolds(db);
    const reminded = (await isWaEnabled(db))
      ? await remindExpiringHolds(db, getMessagingProvider())
      : { reminded: 0, skipped: 0 };
    return { ...expired, ...reminded };
  },
);

// Lançamentos: abre a janela VIP (um evento por convidada, escalonado) e
// publica na hora marcada. A vitrine é ISR (5 min): a peça aparece em breve.
export const dropDispatch = inngest.createFunction(
  { id: "drop-dispatch", triggers: [{ cron: "*/10 * * * *" }] },
  async () => dispatchDueDrops(getDb()),
);

// Conciliação diária com o Mercado Pago (03:00 BRT = 06:00 UTC): rede de
// segurança contra webhook perdido — reprocessa pedidos da loja parados em
// pending_payment que já têm pagamento conhecido. Em ADAPTER_MODE=fake (ou
// sem credenciais) não faz chamada externa alguma além do gateway injetado.
export const mpReconciliation = inngest.createFunction(
  { id: "mp-reconciliation", triggers: [{ cron: "0 6 * * *" }] },
  async () => {
    return reconcilePendingMpOrders(getDb(), getPaymentGateway(), {});
  },
);

// Monitor da sessão Z-API (Fase 4): sessão caída não perde mensagem (tudo
// acumula na fila outbox), mas o dono precisa saber para reescanear o QR.
// Alerta por E-MAIL (o WhatsApp está fora do ar), no máximo 1x por hora.
export const waSessionMonitor = inngest.createFunction(
  { id: "wa-session-monitor", triggers: [{ cron: "*/5 * * * *" }] },
  async () => {
    const db = getDb();
    if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };
    return checkSessionAndAlert(db, getMessagingProvider());
  },
);

// Vigia do WhatsApp: os chats que a Z-API tem × o que o sistema registrou.
// Uma mensagem que o webhook perdeu (caso real: LID, 16/09/2026) vira aviso
// ao dono em até 10 minutos, em vez de dias.
export const waInboundWatchdog = inngest.createFunction(
  { id: "wa-inbound-watchdog", triggers: [{ cron: "*/10 * * * *" }] },
  async () => checkInboundGapsAndAlert(getDb(), getMessagingProvider()),
);

// Qualquer rotina que esgote as tentativas e falhe avisa o dono (WhatsApp +
// e-mail, 1x por hora por rotina). O Inngest dispara este evento sozinho.
// Sem retries (os envios já são capturados; retentar só reenviaria e-mail) e
// uma execução por vez (o cooldown consulta-e-grava no banco não pode correr
// em paralelo). O filtro no gatilho tira a própria função ANTES de rodar —
// senão, com o banco fora, ela falharia e dispararia a si mesma para sempre.
export const functionFailureAlert = inngest.createFunction(
  {
    id: "function-failure-alert",
    retries: 0,
    concurrency: { limit: 1 },
    triggers: [{ event: "inngest/function.failed", if: "event.data.function_id != 'trive-function-failure-alert'" }],
  },
  async ({ event }) => {
    const data = event.data as { function_id?: string; run_id?: string; error?: { message?: string; name?: string } };
    return alertFunctionFailure(getDb(), getMessagingProvider(), {
      functionId: String(data.function_id ?? "?"),
      runId: String(data.run_id ?? ""),
      message: String(data.error?.message ?? data.error?.name ?? "erro sem mensagem"),
    });
  },
);

// Recuperação de pedido não pago (Fase 4): UMA única mensagem por pedido,
// para sempre (dedupe 'wa.recovery:<orderId>' UNIQUE em wa_messages) —
// jamais uma segunda cobrança. Só com opt-in e com a reserva ainda válida.
// Sacola parada: a cada hora, quem sumiu com peças na sacola (opt-in, a
// Lia respondeu por último, sem pedido depois) ganha UMA retomada agendada
// para a janela. 0 horas na ficha da vendedora = a função só devolve "desligado".
export const waIdleCartFollowup = inngest.createFunction(
  { id: "wa-idle-cart-followup", triggers: [{ cron: "7 * * * *" }] },
  async () => {
    return scheduleIdleCartFollowups(getDb());
  },
);

export const waRecovery = inngest.createFunction(
  { id: "wa-recovery", triggers: [{ cron: "*/15 * * * *" }] },
  async () => {
    return recoverUnpaidOrders(getDb(), getMessagingProvider());
  },
);

// Caixa de entrada de e-mail (Fase 6): a Vercel é serverless e não segura uma
// conexão IMAP em IDLE, então cada rodada conecta, lê o que chegou depois do
// maior imap_uid já gravado e fecha. Sem as credenciais no ambiente não há o
// que tentar: o retorno explica o motivo no painel do Inngest em vez de
// acumular uma falha de conexão a cada 2 minutos.
export const emailPoll = inngest.createFunction(
  { id: "email-poll", triggers: [{ cron: "*/2 * * * *" }] },
  async () => {
    if (!isMailboxConfigured()) {
      return { skipped: "caixa_de_entrada_nao_configurada" };
    }
    return pollEmailInbox(getDb(), getMailboxProvider(), getFileStorage());
  },
);

// "Bom dia da maison" (Onda 4): 08:00 em São Paulo = 11:00 UTC (o Brasil não
// tem horário de verão desde 2019; se voltar, trocar para 10). O cron SÓ
// enfileira digest.daily (dedupe por dia): quem monta e envia é o handler do
// outbox — com retry, DLQ e "reprocessar" em /admin/fila.
export const dailyDigest = inngest.createFunction(
  { id: "daily-digest", triggers: [{ cron: "0 11 * * *" }] },
  async () => enqueueDailyDigest(getDb()),
);

// Conversas "com você" paradas por handoff_auto_return_hours voltam para a
// vendedora (0 = nunca). Cada volta é auditada como ação do sistema.
export const waAutoReturn = inngest.createFunction(
  { id: "wa-auto-return", triggers: [{ cron: "*/15 * * * *" }] },
  async () => autoReturnIdleHumanConversations(getDb()),
);

// Saídas do motoboy: fecha as esquecidas abertas há mais de 24 h (avisa a
// dona) e apaga a trilha do GPS com mais de 30 dias (a prova da entrega
// fica na parada).
export const deliveryPositionsPurge = inngest.createFunction(
  { id: "delivery-positions-purge", triggers: [{ cron: "0 7 * * *" }] },
  async () => {
    const db = getDb();
    const stale = await closeStaleDeliveryRuns(db);
    const purge = await purgeOldDeliveryPositions(db);
    return { ...stale, ...purge };
  },
);

// Provador: quem entrou e quem saiu de cada sala (metadata da Z-API), de
// hora em hora; é aqui que o kill switch olha as saídas após o post. Os
// posts em si não precisam de cron: são eventos do outbox com hora marcada.
export const waGroupsSync = inngest.createFunction(
  { id: "wa-groups-sync", triggers: [{ cron: "23 * * * *" }] },
  async () => {
    const db = getDb();
    if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };
    return syncAllGroups(db, getMessagingProvider());
  },
);

export const functions = [
  waGroupsSync,
  functionFailureAlert,
  waInboundWatchdog,
  deliveryPositionsPurge,
  dailyDigest,
  outboxSweep,
  outboxKick,
  reservationExpiry,
  holdExpiry,
  dropDispatch,
  mpReconciliation,
  waSessionMonitor,
  waRecovery,
  waIdleCartFollowup,
  waAutoReturn,
  emailPoll,
];
