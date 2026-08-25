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
