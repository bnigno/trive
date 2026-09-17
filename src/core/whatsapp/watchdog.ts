// Vigia do WhatsApp — PURO. O webhook da Z-API pode falhar em silêncio (caso
// real de 16/09/2026: `phone` como LID, mensagens de clientes novas sumiram
// por dois dias sem ninguém saber). A defesa é comparar duas fontes: a lista
// de chats que o WhatsApp de fato tem (Z-API GET /chats, com a hora da última
// mensagem de cada um) e o que o sistema registrou para cada endereço. Um
// chat com movimento mais novo do que tudo o que temos dele é um BURACO —
// e o dono precisa saber em minutos, não em dias.

export interface WatchdogChat {
  /** Endereço canônico: E.164 ou LID. */
  address: string;
  name: string | null;
  lastMessageAt: Date;
  /** Mensagens ainda não lidas no WhatsApp da loja. */
  unread: number;
}

export interface WatchdogKnown {
  /** Última atividade (qualquer direção) que o sistema registrou. */
  at: Date;
  /** Última mensagem RECEBIDA registrada (null = nenhuma na janela). */
  inboundAt: Date | null;
  /** A vendedora marca as recebidas como lidas nesta conversa (modo autônomo, conversa aberta, bot ligado). */
  botReads: boolean;
}

export interface WatchdogGap {
  address: string;
  name: string | null;
  lastMessageAt: Date;
  /** Última atividade que o sistema tem desse endereço (null = nunca vimos). */
  knownAt: Date | null;
  /** Por que é buraco: movimento mais novo que tudo o que temos, ou não-lida que a Lia teria lido. */
  reason: "movimento_novo" | "nao_lida";
}

export const WATCHDOG = {
  /** Uma mensagem de agora ainda pode estar a caminho do webhook. */
  settleMs: 3 * 60_000,
  /** Só o que aconteceu recentemente: buracos antigos já viraram alerta (ou são de antes do vigia). */
  windowMs: 6 * 60 * 60_000,
  /** Relógios da Z-API e do servidor não são o mesmo. */
  toleranceMs: 2 * 60_000,
} as const;

/**
 * Chats com movimento que o sistema NÃO registrou. Dois sinais:
 * 1. Movimento mais novo que tudo o que temos do endereço (`known.at`). Sem
 *    direção na lista da Z-API, uma mensagem que o dono digitou no celular
 *    da loja também aparece — o alerta diz isso; é um falso positivo barato.
 * 2. Não-lida que a Lia teria lido: a vendedora marca as recebidas como
 *    lidas (✓✓ azul) ao responder; um chat com `unread` e cuja última
 *    recebida registrada é mais velha que a última mensagem do chat é uma
 *    mensagem que nunca chegou — mesmo que um envio nosso (retomada,
 *    recuperação) tenha vindo depois e "atualizado" a atividade.
 */
export function findInboundGaps(input: {
  chats: readonly WatchdogChat[];
  known: ReadonlyMap<string, WatchdogKnown>;
  now: Date;
}): WatchdogGap[] {
  const gaps: WatchdogGap[] = [];
  for (const chat of input.chats) {
    const age = input.now.getTime() - chat.lastMessageAt.getTime();
    if (age < WATCHDOG.settleMs || age > WATCHDOG.windowMs) continue;
    const known = input.known.get(chat.address) ?? null;
    const threshold = chat.lastMessageAt.getTime() - WATCHDOG.toleranceMs;
    if (!known || known.at.getTime() < threshold) {
      gaps.push({ address: chat.address, name: chat.name, lastMessageAt: chat.lastMessageAt, knownAt: known?.at ?? null, reason: "movimento_novo" });
      continue;
    }
    if (chat.unread > 0 && known.botReads && (known.inboundAt === null || known.inboundAt.getTime() < threshold)) {
      gaps.push({ address: chat.address, name: chat.name, lastMessageAt: chat.lastMessageAt, knownAt: known.at, reason: "nao_lida" });
    }
  }
  return gaps.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
}

/** O texto do alerta ao dono: curto, com hora local e o que fazer. */
export function watchdogAlertBody(gaps: readonly WatchdogGap[], timeZone: string): string {
  const time = (date: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  const lines = gaps.slice(0, 5).map((gap) => `• ${gap.name ?? "número oculto"} às ${time(gap.lastMessageAt)}`);
  const more = gaps.length > 5 ? `\n… e mais ${gaps.length - 5}.` : "";
  return `⚠️ WhatsApp: ${gaps.length === 1 ? "um chat teve" : `${gaps.length} chats tiveram`} mensagem que NÃO chegou ao sistema (a Lia não viu):\n${lines.join("\n")}${more}\nSe foi a cliente que escreveu, responda pelo celular da loja e me avise. Se foi você digitando no celular, ignore.`;
}
