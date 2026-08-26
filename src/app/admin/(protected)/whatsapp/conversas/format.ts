import type { BadgeTone } from "@/components/ui/badge";

/** '+5511999991234' -> '(11) •••••-1234' — nunca expõe o número inteiro. */
export function maskPhone(phoneE164: string): string {
  const last4 = phoneE164.slice(-4);
  if (phoneE164.startsWith("+55") && phoneE164.length >= 12) {
    const ddd = phoneE164.slice(3, 5);
    return `(${ddd}) •••••-${last4}`;
  }
  return `•••• ${last4}`;
}

/**
 * Quem está atendendo a conversa agora, na linguagem do painel. 'open' com
 * bot_disabled_until no futuro é o silêncio pós-transferência: ninguém
 * automático responde até o prazo vencer ou o dono devolver ao robô.
 */
export function attendantBadge(
  status: string,
  botDisabledUntil: Date | null,
): { label: string; tone: BadgeTone } {
  if (status === "closed") return { label: "Encerrada", tone: "neutral" };
  if (status === "human") return { label: "Com você", tone: "warning" };
  if (botDisabledUntil && botDisabledUntil.getTime() > Date.now()) {
    return { label: "Robô em pausa", tone: "warning" };
  }
  return { label: "Robô ativo", tone: "success" };
}

export const MESSAGE_STATUS_BADGE: Record<
  string,
  { label: string; tone: BadgeTone }
> = {
  queued: { label: "Na fila", tone: "warning" },
  sent: { label: "Enviada", tone: "info" },
  delivered: { label: "Entregue", tone: "success" },
  read: { label: "Lida", tone: "success" },
  failed: { label: "Falhou", tone: "danger" },
};
