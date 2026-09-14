// Os textos do cartão da edição (PURO): limpeza, família (categoria antes do
// nome; acessório antes de tudo; vestido por último), padrões que cabem no
// cartão, pictogramas de cuidado virando frase, corte na frase com aviso.
import { describe, expect, it } from "vitest";

import {
  careNoteFor,
  DEFAULT_CARE,
  DEFAULT_WEAR,
  EDITION_CURATOR_MAX,
  EDITION_NOTE_MAX,
  EDITION_TITLE_MAX,
  editionFamily,
  editionInvite,
  editionTexts,
  fitEditionNote,
  fitEditionTitle,
  normalizeEditionNote,
  textWidthUnits,
  wearNoteFor,
} from "@/core/edition/text";

describe("fitEditionNote / normalizeEditionNote", () => {
  it("tira emoji sem deixar espaço antes da vírgula, mantém °, $, +, × e acentos em NFD, tab vira espaço", () => {
    expect(normalizeEditionNote("  Linho   puro 😀, respira.  ")).toBe("Linho puro, respira.");
    expect(normalizeEditionNote("Lavar a 30°C, R$ 10, 2+1 × 3, 50%")).toBe("Lavar a 30°C, R$ 10, 2+1 × 3, 50%");
    expect(normalizeEditionNote("Coração")).toBe("Coração");
    expect(normalizeEditionNote("Lave\tà mão")).toBe("Lave à mão");
    // Aspas e traços que a fonte não tem viram os ASCII, como no recibo.
    expect(normalizeEditionNote("„Linho‟ ‹puro› a 10‰ — non‑stop")).toBe("\"Linho\" 'puro' a 10% — non-stop");
    expect(normalizeEditionNote("   ")).toBeNull();
    expect(normalizeEditionNote("…")).toBeNull();
    expect(normalizeEditionNote(null)).toBeNull();
  });

  it("linhas da ficha viram uma só com ' · ' (nada some em silêncio)", () => {
    expect(normalizeEditionNote("Caimento fluido\nComprimento midi\n\nModelo veste M")).toBe(
      "Caimento fluido · Comprimento midi · Modelo veste M",
    );
    const cinco = normalizeEditionNote("a\nb\nc\nd\ne")!;
    expect(cinco).toBe("a · b · c · d · e");
  });

  it("corta no fim da última frase que cabe, avisando; sem frase, na palavra com reticências; nunca em '·'", () => {
    const frases = fitEditionNote("Primeira frase curta. Segunda frase também curta. " + "x".repeat(200));
    expect(frases).toEqual({ text: "Primeira frase curta. Segunda frase também curta.", truncated: true });
    const palavras = fitEditionNote(Array.from({ length: 60 }, () => "palavra").join(" "));
    expect(palavras.truncated).toBe(true);
    expect(textWidthUnits(palavras.text!)).toBeLessThanOrEqual(EDITION_NOTE_MAX);
    expect(palavras.text!.endsWith("palavra…")).toBe(true);
    const separador = fitEditionNote(Array.from({ length: 40 }, () => "abc").join("\n"));
    expect(separador.text).not.toMatch(/[·—,]\s*…$/);
    expect(fitEditionNote("cabe", 10)).toEqual({ text: "cabe", truncated: false });
  });

  it("a frase da curadora: aspas nas pontas saem (o desenho põe as dele), parágrafos viram frases e o teto é maior", () => {
    expect(fitEditionNote("“Amei esta peça.”", EDITION_CURATOR_MAX, { quotes: true })).toEqual({
      text: "Amei esta peça.",
      truncated: false,
    });
    expect(fitEditionNote('"Amei." ', EDITION_CURATOR_MAX, { quotes: true }).text).toBe("Amei.");
    expect(fitEditionNote("Linho puro\nRespira no calor\nÉ isso.", EDITION_CURATOR_MAX, { quotes: true }).text).toBe(
      "Linho puro. Respira no calor. É isso.",
    );
    expect(EDITION_CURATOR_MAX).toBeGreaterThan(EDITION_NOTE_MAX);
  });

  it("o teto é em largura: CAIXA ALTA conta mais e é cortada antes de estourar as linhas do cartão", () => {
    expect(textWidthUnits("ABC")).toBeGreaterThan(textWidthUnits("abc"));
    expect(textWidthUnits("a b")).toBeLessThan(textWidthUnits("abb"));
    // Travessão e reticências são largos: contam como umas duas letras.
    expect(textWidthUnits("—")).toBeGreaterThan(textWidthUnits("aa"));
    expect(textWidthUnits("…")).toBeGreaterThan(textWidthUnits("aa"));
    expect(textWidthUnits("–")).toBeGreaterThan(textWidthUnits("a"));
    const minusculas = "lave a mao com sabao neutro e seque a sombra sem torcer longe do sol e do calor ";
    const cabe = fitEditionNote(minusculas.repeat(2));
    const caixaAlta = fitEditionNote(minusculas.toUpperCase().repeat(2));
    expect(cabe.truncated).toBe(false);
    expect(caixaAlta.truncated).toBe(true);
    expect(textWidthUnits(caixaAlta.text!)).toBeLessThanOrEqual(EDITION_NOTE_MAX);
    expect(caixaAlta.text!.length).toBeLessThan(cabe.text!.length);
  });

  it("o título cabe em duas linhas; mais que isso corta na palavra, avisando", () => {
    expect(fitEditionTitle("Longo Dunas")).toEqual({ text: "Longo Dunas", truncated: false });
    const enorme = fitEditionTitle("Vestido Longo de Linho Puro com Bordado Feito à Mão pelas Artesãs da Ilha do Marajó");
    expect(enorme.truncated).toBe(true);
    expect(enorme.text.endsWith("…")).toBe(true);
    expect(textWidthUnits(enorme.text, "serif")).toBeLessThanOrEqual(EDITION_TITLE_MAX);
    expect(enorme.text).not.toMatch(/\s…$/);
  });

  it("'aprox.' e 'Obs.' não fecham frase: o corte cai na palavra, com reticências", () => {
    const ficha =
      "Caimento solto no corpo, com comprimento na altura do joelho e mangas três quartos. A modelo veste M e tem aprox. 1,72 m de altura, busto 88 cm, cintura 68 cm e quadril 96 cm, e usa sandália baixa nas fotos.";
    const cortado = fitEditionNote(ficha);
    expect(cortado.truncated).toBe(true);
    // A última frase de verdade que cabe é a primeira — não "…tem aprox.".
    expect(cortado.text).toBe("Caimento solto no corpo, com comprimento na altura do joelho e mangas três quartos.");
    const soAprox = fitEditionNote(`A modelo veste M e tem aprox. 1,72 m de altura e ${"usa sandália baixa nas fotos ".repeat(12)}`);
    expect(soAprox.text).not.toMatch(/aprox\.$/);
    expect(soAprox.text!.endsWith("…")).toBe(true);
    const obs = fitEditionNote(`Tecido que acompanha o corpo sem marcar. Obs. a modelo tem 1,70 m e ${"veste M ".repeat(30)}`);
    expect(obs.text).not.toMatch(/Obs\.$/);
    // Um ponto antes de número também não: "veste do 36 ao 38. 40 e 42 sob encomenda".
    const numeros = fitEditionNote(
      `Peça de tecido leve e caimento solto, feita para o calor de Belém, veste do 36 ao 38. 40 e 42 sob encomenda, ${"com prazo de dez dias ".repeat(8)}`,
    );
    expect(numeros.text).not.toMatch(/38\.$/);
    expect(numeros.text!.endsWith("…")).toBe(true);
  });

  it("aspas de citação no meio ou no fim da nota ficam as duas; marcadores de lista somem", () => {
    expect(fitEditionNote('Minha cliente chamou de "a peça do ano"', EDITION_CURATOR_MAX, { quotes: true }).text).toBe(
      'Minha cliente chamou de "a peça do ano".',
    );
    expect(fitEditionNote("Uma cliente disse “nunca vi um linho assim”.", EDITION_CURATOR_MAX, { quotes: true }).text).toBe(
      "Uma cliente disse “nunca vi um linho assim”.",
    );
    expect(normalizeEditionNote("- Lavar à mão\n• Secar à sombra\n* Não torcer")).toBe("Lavar à mão · Secar à sombra · Não torcer");
  });

  it("o convite ao lado do QR muda com o destino", () => {
    expect(editionInvite("peca", "TRIVÉ")).toMatch(/peça/);
    // A loja é chamada pelo nome dela (nunca "maison").
    expect(editionInvite("home", "TRIVÉ")).toBe("Conheça a TRIVÉ e fale com a curadora.");
    expect(editionInvite("home", "TRIVÉ")).not.toBe(editionInvite("peca", "TRIVÉ"));
  });
});

describe("editionFamily", () => {
  it("a categoria decide antes do nome; só sem categoria útil o nome fala", () => {
    expect(editionFamily("Vestidos", "Longo Dunas")).toBe("vestido");
    expect(editionFamily("Acessórios", "Colar Longo Pérola")).toBe("acessorio");
    expect(editionFamily("Saias", "Saia Midi Lírio")).toBe("saia");
    expect(editionFamily("Calças", "Calça Cropped Linho")).toBe("calca");
    expect(editionFamily("Blusas", "Top Curto Sol")).toBe("blusa");
    expect(editionFamily("Acessórios", "Bolsa de Malha")).toBe("acessorio");
    expect(editionFamily("Peças", "Coisa")).toBe("geral");
    expect(editionFamily(null, "Longo Dunas")).toBe("vestido");
    expect(editionFamily(null, "Saia Midi")).toBe("saia");
    expect(editionFamily(null, "BABY LOOK BELLA")).toBe("blusa");
    expect(editionFamily("Vestuário", "Cropped Íris")).toBe("blusa");
  });

  it("acessório e calçado antes de calça; sobreposição e conjunto de brincos no lugar certo", () => {
    expect(editionFamily("Calçados", "Sandália Rasteira")).toBe("acessorio");
    expect(editionFamily("Calçados", "Tênis Branco")).toBe("acessorio");
    expect(editionFamily(null, "Rasteira Ipê")).toBe("acessorio");
    expect(editionFamily("Calças", "Pantalona Areia")).toBe("calca");
    expect(editionFamily("Bijuterias", "Conjunto de brincos")).toBe("acessorio");
    expect(editionFamily(null, "Conjunto colar e brinco")).toBe("acessorio");
    expect(editionFamily("Casacos", "Kimono Rio")).toBe("sobreposicao");
    expect(editionFamily(null, "Jaqueta Jeans")).toBe("sobreposicao");
    expect(editionFamily("Conjuntos", "Conjunto Alfaiataria")).toBe("conjunto");
  });

  it("no nome, a primeira palavra é a peça: 'Saia de Malha' é saia, 'Blusa com Colar' é blusa, 'Top Meia Lua' é blusa", () => {
    expect(editionFamily(null, "Saia de Malha Lua")).toBe("saia");
    expect(editionFamily(null, "Blusa com Colar Bordado")).toBe("blusa");
    expect(editionFamily(null, "Top Meia Lua")).toBe("blusa");
    expect(editionFamily(null, "Calça Tricot Areia")).toBe("calca");
    expect(editionFamily(null, "Vestido Anelise")).toBe("vestido");
    // Palavra inteira: "camisola" não é camisa, "anelise" não é anel, "boneca" não é boné.
    expect(editionFamily(null, "Pijama Camisola Noite")).not.toBe("blusa");
    expect(editionFamily(null, "Body Boneca")).toBe("blusa");
    expect(editionFamily(null, "Blusa térmica")).toBe("blusa");
    // Na primeira palavra também: "Botão de Rosa" não é bota, "Topázio" não é top, "Calcinha" não é calça.
    expect(editionFamily("Edição Círio", "Botão de Rosa Midi")).toBe("vestido");
    expect(editionFamily(null, "Topázio Longo")).toBe("vestido");
    expect(editionFamily(null, "Anelise")).not.toBe("acessorio");
    expect(editionFamily(null, "Colarinho Alto")).not.toBe("acessorio");
    expect(editionFamily(null, "Calcinha Praia")).not.toBe("calca");
    expect(editionFamily(null, "Bota Cano Curto")).toBe("acessorio");
    expect(editionFamily(null, "Top Cropped")).toBe("blusa");
  });

  it("o que não é roupa não tem família — a mesma lista que a Lia usa; só a primeira palavra do nome veta", () => {
    expect(editionFamily("Casa", "Caneca Azul")).toBe("nenhuma");
    expect(editionFamily(null, "Garrafa Térmica 500ml")).toBe("nenhuma");
    expect(editionFamily(null, "Kit de Adesivos")).toBe("nenhuma");
    expect(editionFamily("Casa e Decoração", "Vaso Azul")).toBe("nenhuma");
    expect(editionTexts({ productName: "Caneca", categoryName: "Casa", curatorNote: null, fitNotes: null, careNotes: null })).toBeNull();
    // Flor, cor e estampa no nome não fazem a roupa virar utilidade; nem a categoria "Moda Casa".
    expect(editionFamily("Vestidos", "Vestido Copo-de-Leite")).toBe("vestido");
    expect(editionFamily(null, "Vestido Copo de Leite")).toBe("vestido");
    expect(editionFamily(null, "Blusa Verde Garrafa")).toBe("blusa");
    expect(editionFamily("Blazers", "Blazer Alfaiataria Verde Garrafa")).toBe("sobreposicao");
    expect(editionFamily("Moda Casa", "Robe de Seda")).toBe("geral");
    // A categoria de roupa vence qualquer palavra do nome.
    expect(editionFamily("Vestidos", "Caneca")).toBe("vestido");
  });

  it("semijoias e calçados fora da lista curta são acessório (cuidado com pano seco, não sabão)", () => {
    expect(editionFamily("Semijoias", "Argola Média Banho de Ouro")).toBe("acessorio");
    expect(editionFamily("Joias", "Gargantilha Pérola")).toBe("acessorio");
    expect(editionFamily(null, "Bracelete Dourado")).toBe("acessorio");
    expect(editionFamily(null, "Papete Couro Caramelo")).toBe("acessorio");
    expect(editionFamily(null, "Tamanco Madeira")).toBe("acessorio");
    expect(editionTexts({ productName: "Argola Média", categoryName: "Semijoias", curatorNote: null, fitNotes: null, careNotes: null })!.careNote).toBe(
      DEFAULT_CARE.acessorio,
    );
  });
});

describe("padrões por família", () => {
  it("cabem no cartão e passam pela limpeza sem mudar", () => {
    for (const table of [DEFAULT_WEAR, DEFAULT_CARE]) {
      for (const text of Object.values(table)) {
        expect(textWidthUnits(text)).toBeLessThanOrEqual(EDITION_NOTE_MAX);
        expect(normalizeEditionNote(text)).toBe(text);
      }
    }
    expect(DEFAULT_CARE.sobreposicao).not.toContain("duas partes");
  });
});

describe("wearNoteFor / careNoteFor / editionTexts", () => {
  it("usa a ficha quando existe (com a origem); senão, o padrão da família", () => {
    expect(wearNoteFor("Solta no corpo, vai com sandália.", "vestido")).toEqual({
      text: "Solta no corpo, vai com sandália.",
      truncated: false,
      source: "ficha",
    });
    expect(wearNoteFor("", "saia")).toEqual({ text: DEFAULT_WEAR.saia, truncated: false, source: "padrao" });
    expect(careNoteFor("hand_wash\ndry_shade\nNão torcer", "blusa")).toEqual({
      text: "Não torcer · Lavar à mão · Secar à sombra",
      truncated: false,
      source: "ficha",
      symbolsDropped: 0,
    });
    expect(careNoteFor(null, "calca")).toEqual({ text: DEFAULT_CARE.calca, truncated: false, source: "padrao", symbolsDropped: 0 });
  });

  it("nos cuidados, o texto da dona entra inteiro e os pictogramas só enquanto couberem (contando os que ficam de fora); linha só de emoji não deixa ' ·'", () => {
    const livre = "Lave à mão com sabão de coco, seque na sombra do quintal e passe em temperatura baixa, do avesso, sempre.";
    const cheio = careNoteFor(`hand_wash\nmachine_cold\nno_bleach\ndry_shade\niron_low\nno_iron\ndry_clean\nno_tumble\n${livre}`, "vestido");
    expect(cheio.text!.startsWith(livre)).toBe(true);
    expect(textWidthUnits(cheio.text!)).toBeLessThanOrEqual(EDITION_NOTE_MAX);
    // O texto escrito coube inteiro: o corte é só dos pictogramas.
    expect(cheio.truncated).toBe(false);
    expect(cheio.symbolsDropped).toBeGreaterThan(0);
    expect(cheio.symbolsDropped).toBeLessThan(8);
    const soTexto = careNoteFor(`hand_wash\n${livre} ${livre}`, "vestido");
    expect(soTexto.truncated).toBe(true);
    expect(careNoteFor("hand_wash\n🌿\ndry_shade", "vestido").text).toBe("Lavar à mão · Secar à sombra");
  });

  it("monta os textos: a frase da curadora só quando existe, com o aviso de corte", () => {
    const comNota = editionTexts({
      productName: "Longo Dunas",
      categoryName: "Vestidos",
      curatorNote: "“Escolhi pelo caimento no calor. 🌞”",
      fitNotes: null,
      careNotes: "dry_clean",
    });
    expect(comNota).toEqual({
      family: "vestido",
      title: "Longo Dunas",
      titleTruncated: false,
      curatorNote: "Escolhi pelo caimento no calor.",
      curatorTruncated: false,
      wearNote: DEFAULT_WEAR.vestido,
      wearSource: "padrao",
      wearTruncated: false,
      careNote: "Lavagem a seco",
      careTruncated: false,
      careSymbolsDropped: 0,
    });
    const longa = editionTexts({
      productName: "Longo Dunas",
      categoryName: "Vestidos",
      curatorNote: Array.from({ length: 12 }, (_, i) => `Frase número ${i + 1} da nota da curadora sobre a peça.`).join(" "),
      fitNotes: "Alça longa, cabe um livro.",
      careNotes: null,
    })!;
    expect(longa.curatorTruncated).toBe(true);
    expect(textWidthUnits(longa.curatorNote!, "serif")).toBeLessThanOrEqual(EDITION_CURATOR_MAX);
    expect(longa.curatorNote!.endsWith(".")).toBe(true);
    expect(longa.wearSource).toBe("ficha");
    expect(longa.wearTruncated).toBe(false);
    const fichaLonga = editionTexts({
      productName: "Longo Dunas",
      categoryName: "Vestidos",
      curatorNote: null,
      fitNotes: Array.from({ length: 30 }, () => "caimento solto").join(", "),
      careNotes: null,
    })!;
    expect(fichaLonga.wearTruncated).toBe(true);
    expect(fichaLonga.wearNote.endsWith("…")).toBe(true);
  });
});
