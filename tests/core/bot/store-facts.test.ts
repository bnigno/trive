import { describe, expect, it } from "vitest";

import { renderStoreFacts } from "@/core/bot/store-facts";
import { FICHA_REAL } from "../../helpers/store-facts-fixture";
import { EXCHANGE_FACTS } from "@/core/store/exchange-facts";


describe("renderStoreFacts", () => {
  it("com os dados reais: cidades na ordem, janelas únicas e ordenadas com hora-limite, Correios na hora, pagamento e troca — sem hoje/amanhã e sem maison", () => {
    const texto = renderStoreFacts(FICHA_REAL);
    expect(texto).toContain('• TRIVÉ — moda feminina brasileira. "Para a mulher que se veste de si."');
    expect(texto).toContain("• Sobre: Peças escolhidas com calma");
    expect(texto).toContain("• Endereço: Belém — PA · Instagram: @trive_mfeminine · Site: https://www.trivemaison.com.br");
    expect(texto).toContain("• Atendimento: segunda a sábado, 9h às 19h");
    expect(texto).not.toContain("Retirada:");
    expect(texto).toContain(
      "• Entrega por motoboy em Belém, Ananindeua, Marituba, Castanhal, Santa Izabel, Benevides e Santa Bárbara, nas janelas 9h–12h (pague até 8h) · 16h–19h (pague até 13h) · 19h–21h (pague até 17h).",
    );
    expect(texto).toContain("Onde o motoboy chega não há Correios. Valor e janela do dia: só cotar_frete.");
    expect(texto).toContain("• Fora dessa área: Correios (PAC ou SEDEX) cotados na hora por cotar_frete");
    expect(texto).toContain("• Pagamento: Link de pagamento (Pix ou cartão) que criar_pedido devolve. Pix manual pela equipe só se o link falhar (enviar_chave_pix). dinheiro na entrega só se a cliente pedir.");
    expect(texto).toContain(`arrependimento em até ${EXCHANGE_FACTS.regretDays} dias corridos`);
    expect(texto).toContain(`defeito em até ${EXCHANGE_FACTS.defectDaysDurable} dias`);
    expect(texto).toContain("• Política de troca: Troca ou devolução em até 7 dias após receber, peça sem uso e com etiqueta.");
    expect(texto).not.toMatch(/\bhoje\b|\bamanh[ãa]\b/i);
    expect(texto).not.toMatch(/\bmaison\b/i);
  });

  it("sem motoboy e com Correios pela equipe: uma linha de entrega só, sem prometer valor nem prazo", () => {
    const texto = renderStoreFacts({ ...FICHA_REAL, motoboy: null, correios: "pela_equipe" });
    expect(texto).not.toContain("motoboy");
    expect(texto).toContain("• Entrega: Correios com o frete calculado pela equipe — cotar_frete diz quando é o caso; não há valor nem prazo para prometer.");
  });

  it("política vazia vira 'ainda não cadastrada'; sem link online, o Pix pela chave; campos vazios não geram linha", () => {
    const texto = renderStoreFacts({ ...FICHA_REAL, exchangePolicy: "", about: "", hours: "", address: "", payment: { onlineLink: false, manualPix: true } });
    expect(texto).toContain("• Política de troca: ainda não cadastrada — diga que a equipe explica direitinho e transfira se ela precisar.");
    expect(texto).toContain("• Pagamento: Pix pela chave da loja (enviar_chave_pix) — o link de pagamento online está desligado. dinheiro na entrega só se a cliente pedir.");
    expect(texto).not.toContain("link de pagamento (Pix ou cartão)");
    expect(texto).not.toContain("Sobre:");
    expect(texto).not.toContain("Atendimento:");
    expect(texto).toContain("• Instagram: @trive_mfeminine · Site: https://www.trivemaison.com.br");
  });

  it("janelas diferentes por cidade saem por cidade; faixa de motoboy sem nome de cidade não vira 'só Correios'; política sem ponto duplo", () => {
    const porCidade = renderStoreFacts({
      ...FICHA_REAL,
      motoboy: { area: "Belém e Castanhal", cities: [{ city: "Belém", windows: [{ start: "19:00", end: "21:00", cutoff: "17:00" }] }, { city: "Castanhal", windows: [{ start: "16:00", end: "19:00", cutoff: "13:00" }] }] },
    });
    expect(porCidade).toContain("• Entrega por motoboy em Belém e Castanhal — janelas por cidade: Belém 19h–21h (pague até 17h); Castanhal 16h–19h (pague até 13h).");
    const semNome = renderStoreFacts({ ...FICHA_REAL, motoboy: { area: "", cities: [{ city: "Motoboy", windows: [] }] } });
    expect(semNome).toContain("• Entrega por motoboy na área atendida (cotar_frete diz se o CEP dela entra).");
    expect(semNome).not.toContain("• Entrega: Correios");
    // A política é a última linha: termina com um ponto só, mesmo quando a dona já pôs o dela.
    expect(renderStoreFacts({ ...FICHA_REAL, exchangePolicy: "Troca em 7 dias." }).endsWith("• Política de troca: Troca em 7 dias.")).toBe(true);
    expect(renderStoreFacts({ ...FICHA_REAL, exchangePolicy: "Troca em 7 dias." })).not.toContain("dias..");
    expect(renderStoreFacts({ ...FICHA_REAL, pickup: "Sem loja aberta." })).toContain("• Retirada: Sem loja aberta. Quem quiser retirar combina com a equipe: monte a sacola e chame transferir_para_atendente — criar_pedido só fecha com entrega.");
  });

  it("é determinístico (prefixo cacheável do prompt)", () => {
    expect(renderStoreFacts(FICHA_REAL)).toBe(renderStoreFacts(FICHA_REAL));
  });
});
