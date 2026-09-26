export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

// Políticas por event_type entram aqui (ex.: 'whatsapp.send': { ... }).
// Sem entrada específica, vale a 'default'.
export const RETRY_POLICIES: Record<string, RetryPolicy> = {
  // Pré-desenho do post da peça (publicação e atualização do cartão): ninguém
  // espera na tela (a dona gera de novo quando quiser), então poucas
  // tentativas e rápidas.
  "product.published": {
    maxAttempts: 2,
    baseDelayMs: 10_000,
    maxDelayMs: 60_000,
  },
  "product.card_refresh": {
    maxAttempts: 2,
    baseDelayMs: 10_000,
    maxDelayMs: 60_000,
  },
  // Cartões da edição ao pagar: a dona refaz na tela se precisar.
  "order.edition_cards": {
    maxAttempts: 2,
    baseDelayMs: 10_000,
    maxDelayMs: 60_000,
  },
  // Estorno no Mercado Pago: é DINHEIRO da cliente, então insiste bastante —
  // instabilidade do vendor não pode virar reembolso perdido. A cliente só é
  // avisada depois do sucesso; esgotando as tentativas, o pedido fica
  // "falhou" e o dono devolve à mão.
  // Estorno de UMA peça: mesma régua do estorno total — é dinheiro da cliente.
  "payment.refund_item": {
    maxAttempts: 8,
    baseDelayMs: 10_000,
    maxDelayMs: 3_600_000,
  },
  "payment.refund": {
    maxAttempts: 8,
    baseDelayMs: 10_000,
    maxDelayMs: 3_600_000,
  },
  default: {
    maxAttempts: 8,
    baseDelayMs: 5_000,
    maxDelayMs: 3_600_000,
  },
  // Transcrição de áudio da cliente: a resposta da vendedora espera por ela,
  // então poucas tentativas e rápidas; na última, o serviço cai no marcador
  // "não foi possível transcrever" e a conversa segue.
  // Cartão editorial: 2 tentativas (foto que não abre não melhora com tempo).
  "wa.card_render": { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 30_000 },
  "wa.transcribe": {
    maxAttempts: 3,
    baseDelayMs: 5_000,
    maxDelayMs: 20_000,
  },
  // Chegada pelo Ateliê (fotos + recado → rascunho): a dona espera a
  // resposta no WhatsApp; foto que não baixa não melhora com o tempo, então
  // poucas tentativas e curtas — na última, o serviço avisa a dona.
  "wa.atelier_intake": { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 },
  // Cartão do rascunho para a dona: melhor esforço (o texto já foi); foto
  // que não abre não melhora com o tempo.
  "wa.atelier_card": { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 30_000 },
  // Entrevista da curadora: a pergunta do dia tem de sair no mesmo dia (não
  // adianta tentar por horas); o rascunho a dona espera no WhatsApp — sem a
  // inteligência ele sai da própria fala, então as tentativas são só para
  // banco e envio; a decisão ("ok", "ok voz") baixa o áudio da Z-API.
  // "Me ajuda a escolher?": o placar é resposta ao pedido dela — poucas
  // tentativas e curtas (placar atrasado de horas não serve a ninguém).
  "friends.summary": { maxAttempts: 4, baseDelayMs: 30_000, maxDelayMs: 600_000 },
  "friends.close": { maxAttempts: 6, baseDelayMs: 30_000, maxDelayMs: 1_800_000 },
  "curator.interview_ask": { maxAttempts: 4, baseDelayMs: 30_000, maxDelayMs: 600_000 },
  "curator.interview_draft": { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 },
  "curator.interview_decide": { maxAttempts: 4, baseDelayMs: 10_000, maxDelayMs: 120_000 },
  "wa.customer_look_card": { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 },
  "store.revalidate": { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  // Recibo (entregue/lida) que chegou antes de o balão da Lia existir: o turno
  // commita em segundos; três olhadas espaçadas bastam, depois desiste.
  "wa.status_replay": { maxAttempts: 3, baseDelayMs: 30_000, maxDelayMs: 120_000 },
  // Geocodificação das paradas da saída: melhor esforço (sem pino a entrega
  // segue); o Nominatim fora do ar não melhora em minutos.
  "delivery_run.geocode": { maxAttempts: 4, baseDelayMs: 30_000, maxDelayMs: 300_000 },
  // Turno proativo da Lia (retorno combinado): o modelo pode estar fora do
  // ar por um instante; 3 tentativas espaçadas e a conversa não vira DLQ à toa.
  "wa.bot_followup": { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000 },
  // Post do Provador: a hora do ritual importa (terça 10h não pode virar
  // quarta); 4 tentativas em ~15 min e, se a Z-API seguir fora do ar, a DLQ
  // avisa — a dona reagenda pelo painel.
  "wa.group_post": { maxAttempts: 4, baseDelayMs: 60_000, maxDelayMs: 600_000 },
  "wa.group_poll_close": { maxAttempts: 4, baseDelayMs: 60_000, maxDelayMs: 600_000 },
  // A Lia chamada no grupo: resposta em minutos ou nada (uma resposta duas
  // horas depois no grupo é ruído); 3 tentativas curtas.
  "wa.group_mention": { maxAttempts: 3, baseDelayMs: 30_000, maxDelayMs: 180_000 },
  // Foto no corpo: só a falha ANTES de gastar volta à fila (rede, 429, 5xx
  // do vendor). O 429 da FASHN é limite de chamadas simultâneas da conta:
  // espera de 1 min dobrando, 4 tentativas, e a dona vê "falhou" no painel.
  "product.ai_photo": { maxAttempts: 4, baseDelayMs: 60_000, maxDelayMs: 600_000 },
  "studio.base_photo": { maxAttempts: 4, baseDelayMs: 60_000, maxDelayMs: 600_000 },
  // Vídeo da peça: só volta à fila o que não gastou (429 na entrada, rede ao
  // baixar a foto) ou o que já foi pago e só falta guardar — a retomada pelo
  // id do pedido nunca paga de novo. As rodadas de espera são eventos novos.
  "product.ai_video": { maxAttempts: 4, baseDelayMs: 60_000, maxDelayMs: 600_000 },
  // Push: servidor da Apple/Google fora do ar volta em segundos; depois de
  // 3 tentativas o aviso perdeu o sentido (a próxima mensagem gera outro).
  "push.new_message": { maxAttempts: 3, baseDelayMs: 15_000, maxDelayMs: 60_000 },
  // wa.bot_turn fica na política padrão (banco/provedor fora do ar continuam
  // tentando por até 1 h); o teto do MODELO é próprio e menor
  // (services/wa-bot BOT_TURN_MODEL_ATTEMPTS), com plano B na última.
};

export function getRetryPolicy(eventType: string): RetryPolicy {
  return RETRY_POLICIES[eventType] ?? RETRY_POLICIES["default"];
}

/**
 * Backoff exponencial com jitter: base * 2^(attempt-1), limitado ao teto,
 * multiplicado por um fator em [0.5, 1.5) derivado de `random` (injetável
 * para testes determinísticos; random=0.5 => fator 1.0).
 * `attempt` é 1-based: o número da tentativa que acabou de falhar.
 */
export function nextAttemptDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt));
  const exponential = policy.baseDelayMs * 2 ** (boundedAttempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const jittered = capped * (0.5 + random());
  return Math.min(policy.maxDelayMs, Math.round(jittered));
}

export function classifyOutcome(
  attempts: number,
  maxAttempts: number,
): "retry" | "dead" {
  return attempts >= maxAttempts ? "dead" : "retry";
}

/**
 * Quanto tempo um handler precisa ter pela frente para COMEÇAR dentro do
 * orçamento de uma varredura (a rota do Inngest tem 60 s). Um turno da Lia
 * leva até 35 s de modelo + 12 s de entrega; começar com menos que isso é
 * ser morto no meio e prender a linha no lease. Sem entrada = pode começar
 * com qualquer sobra (o orçamento só barra o que ainda não começou).
 */
export const HANDLER_RESERVE_MS: Record<string, number> = {
  "wa.bot_turn": 32_000,
  "wa.bot_followup": 32_000,
  // Até 8 paradas × (1,1 s de pausa + consulta): começar com menos que isso
  // é parar na 2ª parada e re-enfileirar à toa.
  "delivery_run.geocode": 30_000,
  // Try-on (~10 s) + julgamento (~5 s) + acabamento + Storage: começar com
  // menos é ser morto no meio de uma geração já paga.
  "product.ai_photo": 30_000,
  "studio.base_photo": 30_000,
  // Uma rodada de espera + subir o MP4 (~16 MB): menos que isso, nem começa.
  "product.ai_video": 30_000,
};

export function handlerReserveMs(eventType: string): number {
  return HANDLER_RESERVE_MS[eventType] ?? 0;
}
