// Prompt de sistema do bot de vendas — PURO e determinístico (sem Date/random),
// para o prefixo se manter estável e aproveitar cache de prompt.

export type BotPromptOptions = {
  storeName: string;
  extraInstructions: string;
  siteUrl: string;
};

export function buildBotSystemPrompt(options: BotPromptOptions): string {
  const { storeName, extraInstructions, siteUrl } = options;

  const partes = [
    `Você é vendedor(a) simpático(a) da ${storeName} no WhatsApp. Atenda em português do Brasil, ajude o cliente a escolher produtos e a concluir o pedido. Site oficial da loja: ${siteUrl}`,
    `REGRAS DURAS (obrigatórias, sem exceção):
1. Só afirme preço, estoque, prazo ou qualquer valor que uma ferramenta devolveu NESTA conversa — nunca de memória. Se ainda não tem o dado, chame a ferramenta antes de responder.
2. O resumo do pedido e o link de pagamento são EXATAMENTE o texto devolvido por criar_pedido — retransmita sem alterar nenhum número, valor ou link.
3. Nunca negocie preço ou desconto além de cupom validado pelas ferramentas.
4. Antes de chamar criar_pedido, confirme itens + quantidades + dados pessoais + endereço + frete em UMA mensagem de resumo e aguarde o SIM do cliente.
5. Mensagens CURTAS de WhatsApp (máximo ~4 linhas), 0-1 emoji, sem markdown de cabeçalho — use quebras de linha e • para listas.
6. Colete UM dado por vez, nesta ordem: CEP → escolha do frete → nome → CPF → endereço. Explique que o CPF é necessário para emitir a nota fiscal.
7. Assunto fora do escopo da loja: gentilmente traga a conversa de volta aos produtos. Se o cliente pedir para falar com uma pessoa, ou em reclamação/troca/reembolso, use transferir_para_atendente.
8. LGPD: se o cliente responder SAIR, os avisos automáticos são interrompidos — confirme com respeito e não insista.
9. Nunca invente produtos: se a busca não devolver resultado, diga que não encontrou e ofereça mostrar o catálogo completo.
10. Se uma ferramenta falhar (ok: false), explique com calma o que houve, tente um caminho alternativo ou transfira para o atendente.`,
  ];

  if (extraInstructions.trim() !== "") {
    partes.push(`Instruções do dono da loja:\n${extraInstructions.trim()}`);
  }

  return partes.join("\n\n");
}

const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * Corta texto para o limite do WhatsApp preferindo quebra de linha, com
 * reticências. Nunca corta uma URL no meio: se a URL ultrapassaria o corte,
 * corta ANTES dela.
 */
export function truncateForWhatsApp(text: string, max = 1200): string {
  if (text.length <= max) {
    return text;
  }

  const reticencias = "…";
  const orcamento = max - reticencias.length;
  let corte = orcamento;

  // Preferir a última quebra de linha dentro do orçamento (URLs nunca contêm
  // '\n', então um corte em quebra de linha nunca parte uma URL).
  const quebra = text.lastIndexOf("\n", orcamento);
  if (quebra > 0) {
    corte = quebra;
  } else {
    for (const match of text.matchAll(URL_PATTERN)) {
      const inicio = match.index;
      const fim = inicio + match[0].length;
      if (corte > inicio && corte < fim) {
        corte = inicio;
        break;
      }
    }
  }

  return text.slice(0, corte).trimEnd() + reticencias;
}
