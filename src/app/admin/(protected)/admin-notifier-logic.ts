// Regras do avisador do painel, puras e testadas à parte: o que é novo entre
// dois polls, o ritmo do poll, o texto do aviso e o prefixo "(N)" do título.
import type { LightPollUnseen } from "./whatsapp/conversas/poll/light-schema";

export const CHAT_PATH = "/admin/whatsapp/conversas";

// Aba visível e em uso: 10 s (espera média de 5 s). Sem toque por 10 min:
// 30 s. Aba escondida: 60 s — é o que faz o bipe e o aviso de sistema
// chegarem enquanto você está em outra aba. Erro: dobra até 60 s.
export const POLL_ACTIVE_MS = 10_000;
export const POLL_IDLE_MS = 30_000;
export const POLL_HIDDEN_MS = 60_000;
export const POLL_MAX_BACKOFF_MS = 60_000;
export const IDLE_AFTER_MS = 10 * 60_000;

export function pollDelayMs(input: { hidden: boolean; idleForMs: number; failures: number }): number {
  const base = input.hidden ? POLL_HIDDEN_MS : input.idleForMs >= IDLE_AFTER_MS ? POLL_IDLE_MS : POLL_ACTIVE_MS;
  if (input.failures <= 0) return base;
  return Math.min(base * 2 ** input.failures, POLL_MAX_BACKOFF_MS);
}

export type KnownUnseen = Map<string, { lastInboundAt: string | null; status: string }>;

export function rememberUnseen(items: readonly LightPollUnseen[]): KnownUnseen {
  return new Map(items.map((item) => [item.id, { lastInboundAt: item.lastInboundAt, status: item.status }]));
}

/**
 * O que merece aviso desde o poll anterior: conversa que não estava na
 * lista, mensagem mais recente na mesma conversa (uma vez por mensagem) ou
 * a conversa que passou para o dono. Quem some da lista e volta (foi lida,
 * chegou outra) conta como nova de novo — é o que se quer.
 */
export function freshUnseen(known: KnownUnseen, incoming: readonly LightPollUnseen[]): LightPollUnseen[] {
  return incoming.filter((item) => {
    const previous = known.get(item.id);
    if (!previous) return true;
    if (item.lastInboundAt !== previous.lastInboundAt) {
      // ISO 8601 em UTC compara como texto.
      return item.lastInboundAt !== null && (previous.lastInboundAt === null || item.lastInboundAt > previous.lastInboundAt);
    }
    return item.status === "human" && previous.status !== "human";
  });
}

export function toastTitleFor(item: Pick<LightPollUnseen, "label" | "status">): string {
  return item.status === "human" ? `${item.label} está esperando por você` : `Nova mensagem de ${item.label}`;
}

/** Um aviso de sistema por lote (nunca uma rajada de bipes): singular com prévia, plural com os nomes. */
export function notificationFor(
  fresh: readonly LightPollUnseen[],
  freshSuggestions: readonly { id: string; label: string }[] = [],
): { title: string; body: string | undefined; conversationId: string } | null {
  if (fresh.length === 0) {
    const [first] = freshSuggestions;
    if (!first) return null;
    return {
      title: freshSuggestions.length === 1 ? "A vendedora sugeriu uma resposta" : `${freshSuggestions.length} sugestões da vendedora`,
      body: freshSuggestions.map((item) => item.label).join(", "),
      conversationId: first.id,
    };
  }
  if (fresh.length === 1) {
    const [item] = fresh;
    return { title: toastTitleFor(item), body: item.preview ?? undefined, conversationId: item.id };
  }
  const labels = fresh.slice(0, 3).map((item) => item.label);
  const rest = fresh.length - labels.length;
  return {
    title: `${fresh.length} conversas com mensagem nova`,
    body: rest > 0 ? `${labels.join(", ")} e mais ${rest}` : labels.join(", "),
    conversationId: fresh[0].id,
  };
}

/** "(3) Pedidos | TRIVÉ": prefixa o título que a página já tem; zero tira o prefixo. */
export function withUnreadPrefix(title: string, count: number): string {
  const base = title.replace(/^\(\d+\)\s+/, "");
  return count > 0 ? `(${count}) ${base}` : base;
}
