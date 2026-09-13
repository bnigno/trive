import { describe, expect, it } from "vitest";

import { OPTION_BUTTON_MAX_CHARS } from "@/core/bot/option-list";
import { buildBotSystemPrompt, DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { BOT_TOOLS } from "@/core/bot/tools";
import { VARIANT_MENU_BUTTON_LABEL } from "@/core/bot/variants";

// O vocabulário de restaurante entrava no modelo pela nossa própria boca:
// "menu" aparecia no prompt, nas descrições das ferramentas e nos marcadores.
// Esta varredura falha o build se a palavra voltar a qualquer um deles.
const PALAVRAS_PROIBIDAS = /\b(menu|menus|card[áa]pio|card[áa]pios)\b/iu;

const OPCOES = {
  storeName: "TRIVÉ",
  sellerName: "Lia",
  extraInstructions: "",
  siteUrl: "https://www.trivemaison.com.br",
};

describe("buildBotSystemPrompt", () => {
  it("nunca fala 'menu' nem 'cardápio' — exceto para proibi-los", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    // A única menção permitida é a própria regra do vocabulário.
    const semRegra = prompt
      .split("\n")
      .filter((linha) => !/NUNCA (use )?"menu"/u.test(linha))
      .join("\n");
    expect(semRegra).not.toMatch(PALAVRAS_PROIBIDAS);
  });

  it("descrições e schemas das ferramentas também não", () => {
    const texto = JSON.stringify(BOT_TOOLS);
    expect(texto).not.toMatch(PALAVRAS_PROIBIDAS);
  });

  it("apresenta a vendedora pelo nome, transparente sobre ser IA, com método e caderninho", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    expect(prompt).toContain("Você é Lia, a vendedora da TRIVÉ");
    expect(prompt).toContain("assistente de IA");
    expect(prompt).toContain("COMO VOCÊ VENDE");
    expect(prompt).toContain("CADERNINHO");
    expect(prompt).toContain("adicionar_a_sacola");
  });

  it("ponte do site: com 'Veio do site' no caderninho, vai direto à peça, usa só o estoque informado e nunca repete o código", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    const section = prompt.slice(prompt.indexOf("PONTE DO SITE:"), prompt.indexOf("FOTOS E ÁUDIOS DA CLIENTE:"));
    expect(section).toContain("Veio do site");
    expect(section).toContain("NÃO pergunte");
    expect(section).toContain("Estoque agora das peças da ponte");
    expect(section).toContain("reservar_peca");
    expect(section).toContain("avisar_quando_voltar");
    expect(section).toContain("nunca o repita");
  });

  it("ocasião de Belém: manda usar o filtro edicao e nunca inventar edição", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "", exchangePolicy: "" });
    expect(prompt).toContain("listar_produtos com edicao");
    expect(prompt).toContain("nunca invente uma");
  });

  it("nome vazio cai no padrão; planta da loja e política de troca entram quando existem", () => {
    const prompt = buildBotSystemPrompt({
      ...OPCOES,
      sellerName: "  ",
      storeMap: "• Vestidos (12 peças) — R$ 189,00 a R$ 459,00",
      exchangePolicy: "Troca em até 7 dias com etiqueta.",
    });
    expect(prompt).toContain(`Você é ${DEFAULT_SELLER_NAME},`);
    expect(prompt).toContain("PLANTA DA LOJA");
    expect(prompt).toContain("• Vestidos (12 peças) — R$ 189,00 a R$ 459,00");
    expect(prompt).toContain("Política de troca: Troca em até 7 dias com etiqueta.");
  });

  it("sobre tecido e caimento, a nota da curadora é a palavra dela — cita; sem nada, confere com a equipe", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    expect(prompt).toContain("a nota da curadora dizem");
    expect(prompt).toContain('cite-a ("a curadora diz que…")');
    expect(prompt).toContain("diga que confere com a equipe (nunca invente)");
  });

  it("sem política cadastrada, orienta a transferir em vez de inventar", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    expect(prompt).toContain("Política de troca: ainda não cadastrada");
    expect(prompt).not.toContain("PLANTA DA LOJA");
  });

  it("fechamento: cadastro antes do frete, frete com o CEP do endereço de entrega e a regra 24", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    expect(prompt).toContain(
      "buscar_cadastro (cliente que já comprou: confirme QUAL endereço salvo é o da entrega",
    );
    expect(prompt).toContain("cotar_frete com o CEP do endereço de entrega");
    expect(prompt).toContain("24. FECHAMENTO É DESTA SACOLA");
    expect(prompt).toContain("nunca de memória nem de mensagens de outros dias do histórico");
    expect(prompt).toContain("o nome ou o número exatamente como cotar_frete devolveu");
    expect(prompt).toContain("peça SÓ número e complemento");
  });

  it("é determinístico (prefixo cacheável) e coloca as instruções do dono no fim", () => {
    const a = buildBotSystemPrompt({ ...OPCOES, extraInstructions: "Fale de 'amiga'." });
    const b = buildBotSystemPrompt({ ...OPCOES, extraInstructions: "Fale de 'amiga'." });
    expect(a).toBe(b);
    expect(a.endsWith("Instruções do dono da loja:\nFale de 'amiga'.")).toBe(true);
  });
});

describe("rótulos das listas tocáveis", () => {
  it("botão da lista de variações cabe no teto do WhatsApp", () => {
    expect(VARIANT_MENU_BUTTON_LABEL.length).toBeLessThanOrEqual(OPTION_BUTTON_MAX_CHARS);
    expect(VARIANT_MENU_BUTTON_LABEL).not.toMatch(PALAVRAS_PROIBIDAS);
  });
});
