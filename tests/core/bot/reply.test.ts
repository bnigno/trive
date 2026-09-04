import { describe, expect, it } from "vitest";

import { fixVocabulary, polishBotReply } from "@/core/bot/reply";

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
