import { describe, expect, it } from "vitest";

import { brandWordWarning, ownerTextWarnings } from "@/core/bot/owner-instructions";

describe("ownerTextWarnings", () => {
  it("avisa quando o texto pede o nome da cliente, promete desconto ou chama a loja de maison", () => {
    const avisos = ownerTextWarnings(
      "Comece cumprimentando e perguntando seu nome. Chame-a pelo nome durante a conversa. Ofereça 10% de desconto na primeira compra. Somos a maison da mulher paraense.",
    );
    expect(avisos).toHaveLength(3);
    expect(avisos[0]).toContain("A Lia nunca pergunta o nome");
    expect(avisos[1]).toContain("cupom validado");
    expect(avisos[2]).toBe('A loja se chama TRIVÉ: a Lia nunca a chame de "maison" — escreva TRIVÉ no seu texto.');
  });

  it("texto de tom e fatos passa limpo; 'nome' sem pedir e 'promoção' só do lado do sistema não disparam à toa", () => {
    expect(ownerTextWarnings("Fale de você, com calma e sem gíria. A produção é em Belém, em edições pequenas. Saudação: Oii, musaa 🤎")).toEqual([]);
    expect(ownerTextWarnings("O nome da coleção é Noite de Estreia.")).toEqual([]);
    expect(ownerTextWarnings("")).toEqual([]);
  });

  it("brandWordWarning só olha a palavra inteira (o domínio trivemaison não conta)", () => {
    expect(brandWordWarning("Nosso site é trivemaison.com.br")).toBeNull();
    expect(brandWordWarning("A Maison Féminine")).not.toBeNull();
  });
});
