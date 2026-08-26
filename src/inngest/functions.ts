import { getMailboxProvider, isMailboxConfigured } from "@/adapters/mailbox";
import { getPaymentGateway } from "@/adapters/mercadopago";
import { getFileStorage } from "@/adapters/storage";
import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { inngest } from "@/inngest/client";
import { drainOutbox, type DrainOutboxResult } from "@/queue/worker";
import { pollEmailInbox } from "@/services/email-inbox";
import { reconcilePendingMpOrders } from "@/services/payments";
import { expireOverdueReservations } from "@/services/store-orders";
import { isWaEnabled, recoverUnpaidOrders } from "@/services/wa-messaging";
import { checkSessionAndAlert } from "@/services/wa-session";

const SWEEP_BATCH_LIMIT = 25;
const SWEEP_MAX_BATCHES = 10;

export const outboxSweep = inngest.createFunction(
  { id: "outbox-sweep", triggers: [{ cron: "* * * * *" }] },
  async () => {
    const db = getDb();
    const totals: DrainOutboxResult = {
      recovered: 0,
      claimed: 0,
      done: 0,
      failed: 0,
      dead: 0,
    };
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const result = await drainOutbox(db, { limit: SWEEP_BATCH_LIMIT });
      totals.recovered += result.recovered;
      totals.claimed += result.claimed;
      totals.done += result.done;
      totals.failed += result.failed;
      totals.dead += result.dead;
      if (result.claimed === 0) break;
    }
    return totals;
  },
);

export const outboxKick = inngest.createFunction(
  { id: "outbox-kick", triggers: [{ event: "outbox/event.enqueued" }] },
  async () => {
    return drainOutbox(getDb(), { limit: 10 });
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

// Recuperação de pedido não pago (Fase 4): UMA única mensagem por pedido,
// para sempre (dedupe 'wa.recovery:<orderId>' UNIQUE em wa_messages) —
// jamais uma segunda cobrança. Só com opt-in e com a reserva ainda válida.
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

export const functions = [
  outboxSweep,
  outboxKick,
  reservationExpiry,
  mpReconciliation,
  waSessionMonitor,
  waRecovery,
  emailPoll,
];
