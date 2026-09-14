// Carimbos de mensagens nos testes do bot: crescentes e nunca no futuro. As
// respostas da Lia nascem com o now() do banco (início da transação, com
// microssegundos); um carimbo no passado distante fazia a mensagem nova
// parecer anterior à resposta, e um no futuro faria a resposta parecer
// anterior à mensagem. Quando o relógio ainda não andou, espera 1 ms.
let lastStamp = 0;

export function nextMessageStamp(): Date {
  while (Date.now() - 1 <= lastStamp) {
    // espera o relógio andar (≤ 1 ms)
  }
  lastStamp = Date.now() - 1;
  return new Date(lastStamp);
}
