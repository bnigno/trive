// Carimbos de mensagens nos testes do bot: crescentes e nunca no futuro. As
// respostas da Lia nascem com o now() do banco (início da transação, com
// microssegundos); um carimbo no passado distante fazia a mensagem nova
// parecer anterior à resposta (turno "já respondido"), e um no futuro fazia
// a resposta parecer anterior à mensagem (turno rodando de novo).
let lastStamp = 0;

export function nextMessageStamp(): Date {
  lastStamp = Math.max(Date.now() - 1, lastStamp + 1);
  return new Date(lastStamp);
}
