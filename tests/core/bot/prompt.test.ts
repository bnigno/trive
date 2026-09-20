import { describe, expect, it } from "vitest";

import { OPTION_BUTTON_MAX_CHARS } from "@/core/bot/option-list";
import { buildBotSystemPrompt, DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { renderStoreFacts } from "@/core/bot/store-facts";
import { BOT_TOOLS } from "@/core/bot/tools";
import { VARIANT_MENU_BUTTON_LABEL } from "@/core/bot/variants";
import { FICHA_REAL } from "./store-facts.test";

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

  it("fotos: primeiro identificar_peca_na_foto (foto da loja), Quem já vestiu para foto dela, parecidas só quando não reconhece; marcadores na regra 23", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    const section = prompt.slice(prompt.indexOf("FOTOS E ÁUDIOS DA CLIENTE:"), prompt.indexOf("REGRAS DURAS"));
    expect(section).toContain("identificar_peca_na_foto");
    expect(section).toContain("QUEM JÁ VESTIU");
    expect(section).toContain("sem reenviar o catálogo");
    expect(section).toContain("nunca o corpo, o rosto, a idade");
    expect(section).not.toContain("Em seguida busque com listar_produtos (categoria + cor + busca) as 2 ou 3 peças");
    expect(prompt).toContain("[reconhecimento exato]");
    expect(prompt).toContain("[reconhecimento provável]");
    expect(prompt).toContain("é identificar_peca_na_foto (ou o fluxo normal de fotos)");
  });

  it("a loja é chamada pelo nome dela: o prompt nunca a chama de 'maison' (só proíbe a palavra) — com a ficha real dentro", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "", storeFacts: renderStoreFacts(FICHA_REAL) });
    expect(prompt).toContain("A TRIVÉ é uma marca de moda brasileira");
    expect(prompt).toContain("A loja se chama TRIVÉ — nunca a chame de \"maison\"");
    // Fora da proibição, a palavra não aparece em lugar nenhum do prompt.
    expect(prompt.replace(/nunca a chame de "maison"/g, "")).not.toMatch(/\bmaison\b/i);
  });

  it("ocasião de Belém: manda usar o filtro edicao e nunca inventar edição", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "" });
    expect(prompt).toContain("listar_produtos com edicao");
    expect(prompt).toContain("nunca invente uma");
  });

  it("regra 27: 'chegou' → confirmar_entrega, só quando a cliente disser que recebeu", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "" });
    expect(prompt).toContain("27. CHEGOU");
    expect(prompt).toContain("confirmar_entrega");
  });

  it("regra 13: peça na sacola não se adiciona de novo, quantidade é o total, SKU nunca vai para a cliente; regra 3 não promete SKU no histórico", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "" });
    expect(prompt).toContain("peça que já está na sacola não se adiciona de novo");
    expect(prompt).toContain("quantidade é o TOTAL da linha");
    expect(prompt).toContain("NUNCA escreva um SKU para a cliente");
    expect(prompt).toContain("valem dentro deste turno");
    expect(prompt).not.toContain("ficam no histórico — não chame de novo");
  });

  it("regra 26: fora da área do motoboy, Correios com frete calculado pela equipe — transferir, nunca inventar valor nem criar_pedido", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "" });
    expect(prompt).toContain("26. FORA DA ÁREA DO MOTOBOY");
    expect(prompt).toContain("Quando cotar_frete devolver PAC/SEDEX com valor e prazo");
    expect(prompt).toContain("transferir_para_atendente com o resumo");
    expect(prompt).toContain("Nunca chame criar_pedido sem uma cotação desta conversa");
  });

  it("regra 25: janelas só as que cotar_frete devolveu e a data marcada via entregar_ate", () => {
    const prompt = buildBotSystemPrompt({ storeName: "TRIVÉ", sellerName: "Lia", siteUrl: "https://x", extraInstructions: "" });
    expect(prompt).toContain("25. JANELAS E DATA MARCADA");
    expect(prompt).toContain("entregar_ate em cotar_frete");
  });

  it("nome vazio cai no padrão; planta da loja e ficha da loja (com a política de troca) entram quando existem — a ficha logo depois da apresentação", () => {
    const prompt = buildBotSystemPrompt({
      ...OPCOES,
      sellerName: "  ",
      storeMap: "• Vestidos (12 peças) — R$ 189,00 a R$ 459,00",
      storeFacts: renderStoreFacts({ ...FICHA_REAL, exchangePolicy: "Troca em até 7 dias com etiqueta." }),
    });
    expect(prompt).toContain(`Você é ${DEFAULT_SELLER_NAME},`);
    expect(prompt).toContain("PLANTA DA LOJA");
    expect(prompt).toContain("• Vestidos (12 peças) — R$ 189,00 a R$ 459,00");
    expect(prompt).toContain("FICHA DA LOJA (fatos fixos da casa");
    expect(prompt).toContain("Política de troca: Troca em até 7 dias com etiqueta.");
    expect(prompt).toContain("Entrega por motoboy em Belém, Ananindeua");
    expect(prompt.indexOf("FICHA DA LOJA")).toBeGreaterThan(prompt.indexOf("Você é"));
    expect(prompt.indexOf("FICHA DA LOJA")).toBeLessThan(prompt.indexOf("JEITO DE FALAR"));
    // A política de troca e o prazo saíram de OBJEÇÕES: moram na ficha e na regra 1.
    expect(prompt).not.toContain("• Prazo de entrega: só o que cotar_frete devolveu.");
  });

  it("sobre tecido e caimento, só o que detalhar_produto trouxer (a ferramenta diz como citar a nota); sem nada, confere com a equipe", () => {
    const prompt = buildBotSystemPrompt(OPCOES);
    expect(prompt).toContain("a nota da curadora que detalhar_produto trouxer dizem");
    expect(prompt).not.toContain('cite-a ("a curadora diz que…")');
    expect(prompt).toContain("enviar_nota_da_curadora");
    expect(prompt).toContain("diga que confere com a equipe (nunca invente)");
  });

  it("sem política cadastrada, a ficha orienta a transferir em vez de inventar; sem ficha nem planta, os blocos não aparecem", () => {
    const prompt = buildBotSystemPrompt({ ...OPCOES, storeFacts: renderStoreFacts({ ...FICHA_REAL, exchangePolicy: "" }) });
    expect(prompt).toContain("Política de troca: ainda não cadastrada");
    expect(prompt).not.toContain("PLANTA DA LOJA");
    const nu = buildBotSystemPrompt(OPCOES);
    expect(nu).not.toContain("FICHA DA LOJA");
    expect(nu).not.toContain("Política de troca:");
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

  it("é determinístico (prefixo cacheável); o tom do dono vem depois da ficha e da planta, subordinado ao método", () => {
    const opcoes = { ...OPCOES, extraInstructions: "Fale de 'amiga'.", storeFacts: renderStoreFacts(FICHA_REAL), storeMap: "• Vestidos (12 peças)" };
    const a = buildBotSystemPrompt(opcoes);
    const b = buildBotSystemPrompt(opcoes);
    expect(a).toBe(b);
    const dono = a.indexOf("TOM E FATOS DO DONO");
    expect(dono).toBeGreaterThan(a.indexOf("FICHA DA LOJA"));
    expect(dono).toBeGreaterThan(a.indexOf("PLANTA DA LOJA"));
    expect(a.slice(dono)).toContain("prevalecem");
    expect(a.slice(dono)).toContain("Fale de 'amiga'.");
  });
});

describe("rótulos das listas tocáveis", () => {
  it("botão da lista de variações cabe no teto do WhatsApp", () => {
    expect(VARIANT_MENU_BUTTON_LABEL.length).toBeLessThanOrEqual(OPTION_BUTTON_MAX_CHARS);
    expect(VARIANT_MENU_BUTTON_LABEL).not.toMatch(PALAVRAS_PROIBIDAS);
  });
});
