export type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export const outboxHandlers: Record<string, OutboxHandler> = {
  "system.ping": async (event) => {
    console.log(`[outbox] system.ping received (event ${event.id})`);
  },
  // Preço ativado → revalida a vitrine pública. Fora do runtime do Next
  // (worker standalone, testes) revalidatePath pode lançar: capturamos e
  // logamos — o cache expira sozinho e o evento não deve ir para a DLQ.
  "price.activated": async (event) => {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/", "layout");
    } catch (error) {
      console.warn(
        `[outbox] price.activated (event ${event.id}): revalidatePath indisponível neste contexto.`,
        error,
      );
    }
  },
  // Pedido criado pela loja. Fase 4: notificar o dono via WhatsApp.
  // Por enquanto é no-op de propósito — o registro evita UnknownEventTypeError.
  "order.store_created": async () => {},
};

export class UnknownEventTypeError extends Error {
  constructor(eventType: string) {
    super(
      `Nenhum handler registrado para event_type "${eventType}". ` +
        `Registre-o em src/queue/handlers/index.ts.`,
    );
    this.name = "UnknownEventTypeError";
  }
}

export function resolveOutboxHandler(eventType: string): OutboxHandler {
  const handler = outboxHandlers[eventType];
  if (!handler) throw new UnknownEventTypeError(eventType);
  return handler;
}
