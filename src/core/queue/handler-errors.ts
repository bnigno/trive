// Erros que um handler da fila lança para dizer ao worker COMO tratar a
// linha — sem o worker conhecer os serviços (core não importa ninguém).

/**
 * O handler esperou (o lock da conversa, por exemplo) e não sobrou tempo para
 * fazer o trabalho nesta invocação, ANTES de qualquer efeito: a linha volta à
 * fila sem contar tentativa e outra invocação, com orçamento inteiro, cuida.
 */
export class HandlerOutOfTimeError extends Error {
  constructor(readonly remainingMs: number) {
    super(`Sem tempo para o handler nesta invocação: sobravam ${remainingMs} ms.`);
    this.name = "HandlerOutOfTimeError";
  }
}
