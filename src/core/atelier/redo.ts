// "Refazer" uma chegada — PURO. Só faz sentido quando dá para desfazer sem
// mexer no que é ledger: a chegada que já lançou estoque (movimentos
// append-only) não se refaz por aqui — a dona ajusta pelo painel. A que
// falhou, ou virou rascunho sem estoque, pode nascer de novo: o rascunho
// antigo é arquivado (nunca apagado) e a conta a pagar pendente, cancelada.
// Peça que a dona já pôs na vitrine não se refaz (edite pela ficha), e uma
// chegada com montagem ainda viva na fila espera.
export type RedoCheckInput = {
  status: string;
  /** Movimentos de estoque que a chegada lançou — contados no LEDGER, não numa foto de uma tentativa. */
  movements: number;
  /** Há evento de montagem vivo na fila (pendente, rodando ou à espera de nova tentativa)? */
  hasLiveEvent: boolean;
  /** Status do produto que a chegada gerou (null sem produto). */
  productStatus: string | null;
};

export type RedoBlockedReason = "em_andamento" | "estoque_lancado" | "peca_ativa";
export type RedoCheck = { ok: true } | { ok: false; reason: RedoBlockedReason };

export function canRedoIntake(input: RedoCheckInput): RedoCheck {
  if (input.hasLiveEvent) return { ok: false, reason: "em_andamento" };
  if (input.movements > 0) return { ok: false, reason: "estoque_lancado" };
  if (input.productStatus === "active") return { ok: false, reason: "peca_ativa" };
  return { ok: true };
}

export const REDO_BLOCKED_LABELS: Record<RedoBlockedReason, string> = {
  em_andamento: "Ainda está sendo montada.",
  estoque_lancado: "Já lançou estoque: ajuste pelo painel (estoque é histórico, não se desfaz).",
  peca_ativa: "A peça já está na vitrine: edite pela ficha.",
};

/** Chave de dedupe de uma rodada: a primeira sem sufixo (compatível com o que já existe), as seguintes com ":rN". */
export function roundSuffix(redoCount: number): string {
  return redoCount > 0 ? `:r${redoCount}` : "";
}
