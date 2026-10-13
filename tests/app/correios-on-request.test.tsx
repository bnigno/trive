// O aviso "sem frete automático" do carrinho e do checkout: fora da área do
// motoboy é Correios; dentro dela, com a sacola fora do peso das faixas, é
// motoboy com o frete confirmado pela equipe — nunca "Correios" (Benevides,
// out/2026).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CorreiosOnRequestNotice } from "@/components/store/order/correios-on-request";

const BASE = { cepDigits: "68797000", sellerName: "Lia", fallbackUrl: null, items: [] };

describe("CorreiosOnRequestNotice", () => {
  it("fora da área do motoboy: Correios, com as cidades do motoboy", () => {
    const html = renderToStaticMarkup(<CorreiosOnRequestNotice {...BASE} cepDigits="01310100" motoboyArea="Belém e Benevides" />);
    expect(html).toContain("Fora de Belém e Benevides, a entrega para este CEP é pelos <strong>Correios</strong>");
  });

  it("o motoboy cobre o CEP mas não o peso: motoboy com o frete pela equipe, sem Correios", () => {
    const html = renderToStaticMarkup(<CorreiosOnRequestNotice {...BASE} motoboyArea="" motoboyCoversCep />);
    expect(html).toContain("Este CEP é atendido pelo nosso <strong>motoboy</strong>");
    expect(html).toContain("o peso desta sacola está fora do que a entrega automática aceita");
    expect(html).toContain("o frete é confirmado pela nossa equipe");
    expect(html).not.toContain("Correios");
  });
});
