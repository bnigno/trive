// "Refazer" uma chegada — PURO. Só faz sentido quando dá para desfazer sem
// mexer no que é ledger: a chegada que já lançou estoque (movimentos
// append-only) não se refaz por aqui — a dona ajusta pelo painel. A que
// falhou, ou virou rascunho sem estoque, pode nascer de novo: o rascunho
// antigo é arquivado (nunca apagado) e a conta a pagar pendente, cancelada.
export type RedoCheckInput = {
  status: string;
  /** Movimentos de estoque que a chegada lançou (parsed.purchase.movements). */
  movements: number;
};

export type RedoCheck = { ok: true } | { ok: false; reason: "em_andamento" | "estoque_lancado" };

export function canRedoIntake(input: RedoCheckInput): RedoCheck {
  if (input.status === "queued") return { ok: false, reason: "em_andamento" };
  if (input.movements > 0) return { ok: false, reason: "estoque_lancado" };
  return { ok: true };
}

export const REDO_BLOCKED_LABELS: Record<Exclude<RedoCheck, { ok: true }>["reason"], string> = {
  em_andamento: "Ainda está sendo montada.",
  estoque_lancado: "Já lançou estoque: ajuste pelo painel (estoque é histórico, não se desfaz).",
};
