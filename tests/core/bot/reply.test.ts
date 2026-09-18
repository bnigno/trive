import { describe, expect, it } from "vitest";

import { CURATOR_AUDIO_RECORDING_SECONDS, fixVocabulary, polishBotReply, splitBotReply, typingSecondsFor } from "@/core/bot/reply";

describe("fixVocabulary", () => {
  it("troca menu e cardápio por catálogo, preservando a caixa e o plural", () => {
    expect(fixVocabulary("Toque no menu para ver o cardápio")).toBe(
      "Toque no catálogo para ver o catálogo",
    );
    expect(fixVocabulary("Menu de hoje")).toBe("Catálogo de hoje");
    expect(fixVocabulary("MENU")).toBe("CATÁLOGO");
    expect(fixVocabulary("Temos dois menus e três cardapios")).toBe(
      "Temos dois catálogos e três catálogos",
    );
  });

  it("não mexe em palavras que só contêm o termo", () => {
    expect(fixVocabulary("O documento foi menusculamente revisado")).toBe(
      "O documento foi menusculamente revisado",
    );
    expect(fixVocabulary("Submenu não existe")).toBe("Submenu não existe");
  });
});

describe("polishBotReply", () => {
  it("limpa linhas em branco em excesso e espaços nas pontas", () => {
    expect(polishBotReply("  Oi!  \n\n\n\nVeja o menu 👇  ")).toBe(
      "Oi!\n\nVeja o catálogo 👇",
    );
  });
});

describe("polishBotReply — marcadores da lista tocável", () => {
  it("o marcador com a faixa (e o de lista que falhou) some mesmo no meio da frase", () => {
    expect(polishBotReply("Já mandei tudo [lista tocável do catálogo (11–20 de 25) enviada ao cliente] logo acima.")).toBe("Já mandei tudo logo acima.");
    expect(polishBotReply("Olha [lista tocável do catálogo enviada ao cliente] aí.")).toBe("Olha aí.");
    expect(polishBotReply("Vou reenviar [lista tocável do catálogo (1–10 de 25) que NÃO chegou à cliente (falhou)] agora.")).toBe("Vou reenviar agora.");
  });
});

describe("splitBotReply", () => {
  it("sem separador: um balão só, já polido", () => {
    expect(splitBotReply("Oi, Maria!\n\n\n\nQual a ocasião?")).toEqual([
      "Oi, Maria!\n\nQual a ocasião?",
    ]);
  });

  it("divide em balões pela linha '---' e descarta blocos vazios", () => {
    expect(splitBotReply("Amei a ideia 💛\n---\nO Dunas é de linho.\n---\n\n---\nVai de M ou G?")).toEqual([
      "Amei a ideia 💛",
      "O Dunas é de linho.",
      "Vai de M ou G?",
    ]);
  });

  it("mais de 3 blocos: o excedente cola no último (nada se perde)", () => {
    expect(splitBotReply("a\n---\nb\n---\nc\n---\nd\n---\ne")).toEqual([
      "a",
      "b",
      "c\n\nd\n\ne",
    ]);
  });

  it("um traço no meio de uma linha não é separador", () => {
    expect(splitBotReply("Preço --- R$ 10\n---\nok")).toEqual([
      "Preço --- R$ 10",
      "ok",
    ]);
  });
});

describe("stripInternalMarkers (anotações internas nunca chegam à cliente)", () => {
  it("remove o marcador de foto/lista copiado pelo modelo, no começo e no meio", async () => {
    const { polishBotReply, splitBotReply, stripInternalMarkers } = await import("@/core/bot/reply");
    expect(
      polishBotReply(
        "[foto enviada ao cliente] Bolsa Tote de Algodão — R$ 34,90\n\nResistente e com estampa exclusiva, R$ 34,90 🤎\n\nQuer que eu já coloque na sua sacola?",
      ),
    ).toBe("Bolsa Tote de Algodão — R$ 34,90\n\nResistente e com estampa exclusiva, R$ 34,90 🤎\n\nQuer que eu já coloque na sua sacola?");
    expect(stripInternalMarkers("Olha ela: [foto enviada ao cliente] Vestido Dunas")).toBe("Olha ela: Vestido Dunas");
    expect(stripInternalMarkers("[A foto da peça foi enviada ao cliente.]\nVeste M?")).toBe("Veste M?");
    expect(stripInternalMarkers("[lista tocável do catálogo enviada ao cliente]\nToque em «Ver o catálogo» 👇")).toBe("Toque em «Ver o catálogo» 👇");
    expect(splitBotReply("[Um cartão com as fotos foi enviado junto com a lista.]\nMandei um cartão com as três 🤎\n---\nQual chamou sua atenção?")).toEqual([
      "Mandei um cartão com as três 🤎",
      "Qual chamou sua atenção?",
    ]);
  });

  it("deixa colchetes curtos de verdade em paz", async () => {
    const { stripInternalMarkers } = await import("@/core/bot/reply");
    expect(stripInternalMarkers("Tem no [M] e no [G].")).toBe("Tem no [M] e no [G].");
    expect(stripInternalMarkers("[ok] combinado")).toBe("[ok] combinado");
  });
});

describe("typingSecondsFor (\"digitando…\" antes do balão)", () => {
  it("1 s por ~40 caracteres, mínimo 1 s", () => {
    expect(typingSecondsFor("oi", "first")).toBe(1);
    expect(typingSecondsFor("", "next")).toBe(1);
    expect(typingSecondsFor("x".repeat(40), "next")).toBe(1);
    expect(typingSecondsFor("x".repeat(41), "next")).toBe(2);
  });

  it("o primeiro balão fica curto (ela já pensou); os seguintes um pouco mais", () => {
    const longo = "x".repeat(400);
    expect(typingSecondsFor(longo, "first")).toBe(2);
    expect(typingSecondsFor(longo, "next")).toBe(3);
    expect(typingSecondsFor("x".repeat(160), "first")).toBe(2);
    expect(typingSecondsFor("x".repeat(100), "next")).toBe(3);
  });

  it("a nota da curadora mostra 'gravando áudio…' por alguns segundos", () => {
    expect(CURATOR_AUDIO_RECORDING_SECONDS).toBeGreaterThanOrEqual(1);
    expect(CURATOR_AUDIO_RECORDING_SECONDS).toBeLessThanOrEqual(15);
  });
});
