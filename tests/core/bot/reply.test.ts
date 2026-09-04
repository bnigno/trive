import { describe, expect, it } from "vitest";

import { fixVocabulary, polishBotReply, splitBotReply } from "@/core/bot/reply";

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
