// Origem de uma mensagem do WhatsApp para exibição no painel: quem "falou" —
// o cliente, o robô de vendas, o dono (resposta manual) ou uma automação
// (notificação de pedido, aviso de estoque etc.). Derivada de dados que a
// mensagem já carrega; nada é gravado a mais no banco.
export type WaMessageOrigin = "customer" | "bot" | "manual" | "auto";

export interface DeriveWaMessageOriginInput {
  direction: string;
  templateKey: string | null;
  dedupeKey: string | null;
}

/**
 * A ordem dos testes importa e é contrato:
 * 1. inbound → customer (tudo que chega é do cliente);
 * 2. dedupe `wa.bot_*` → bot (reply/media/handoff_notice do robô);
 * 3. dedupe `wa.send:` → manual (exclusivo do envio do dono pelo painel);
 * 4. templateKey presente → auto (notificações de pedido/estoque);
 * 5. fallback → auto (outbound sem assinatura conhecida).
 */
export function deriveWaMessageOrigin(
  input: DeriveWaMessageOriginInput,
): WaMessageOrigin {
  if (input.direction === "inbound") return "customer";
  if (input.dedupeKey?.startsWith("wa.bot_")) return "bot";
  if (input.dedupeKey?.startsWith("wa.send:")) return "manual";
  if (input.templateKey) return "auto";
  return "auto";
}
