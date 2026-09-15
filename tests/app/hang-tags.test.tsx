// A tag de cabide sem navegador: renderização estática dos componentes de
// apresentação. Frente só com a marca; verso espelhado na folha A4 (duplex
// na borda longa); gráfica com duas páginas por modelo; CSS de impressão com
// o tamanho de página certo.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LabelDesign, ProductLabel } from "@/core/catalog/labels";
import { qrSvgPath } from "@/receipts/qr";

import { HangTagBack, HangTagDefs, HangTagFront, TAG } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag";
import { HangTagPress, PRESS_PAGE } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag-press";
import { HangTagSheet, HangTagSheets, SHEET_A4, SHEET_A4_MARGIN } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag-sheets";
import { printCss } from "@/app/admin/(protected)/produtos/[id]/etiquetas/print-css";

const URL_PECA = "https://trivemaison.com.br/produto/longo-dunas";

function label(index: number, sku = `DUNAS-AREIA-${index}`): ProductLabel {
  return {
    key: `v${index}`,
    storeName: "TRIVÉ",
    productName: "Longo Dunas",
    variantLabel: `Areia · ${["P", "M", "G"][index % 3]}`,
    sku,
    priceCents: null,
    composition: "100% linho",
    productUrl: URL_PECA,
  };
}

describe("tag de cabide — frente e verso", () => {
  it("a frente é só a marca: monograma, letreiro TRIVÉ e tagline; nada da peça", () => {
    const html = renderToStaticMarkup(<HangTagFront storeName="TRIVÉ" />);
    expect(html).toContain('href="#tag-wordmark"');
    expect(html).toContain('href="#tag-tagline"');
    expect(html).toContain("/brand/mark-");
    expect(html).not.toContain("DUNAS");
    expect(html).not.toContain("REF.");
    // Loja com outro nome: o letreiro dá lugar ao nome em texto.
    const outra = renderToStaticMarkup(<HangTagFront storeName="Maison Aurora" />);
    expect(outra).not.toContain("#tag-wordmark");
    expect(outra).toContain("Maison Aurora");
  });

  it("o verso traz nome, cor/tamanho, referência, composição, QR e o endereço — sem preço", () => {
    const html = renderToStaticMarkup(<HangTagBack label={{ ...label(1), priceCents: 28900 }} />);
    expect(html).toContain("Longo Dunas");
    expect(html).toContain("Areia · M");
    expect(html).toContain("REF. DUNAS-AREIA-1");
    expect(html).toContain("100% linho");
    expect(html).toContain('href="#tag-qr"');
    expect(html).toContain("trivemaison.com.br");
    expect(html).not.toContain("289");
    expect(html).not.toContain("R$");
  });

  it("as definições trazem o QR da peça como path e o letreiro como símbolos", () => {
    const qr = qrSvgPath(URL_PECA);
    const html = renderToStaticMarkup(<HangTagDefs qr={qr} />);
    expect(html).toContain('id="tag-wordmark"');
    expect(html).toContain('id="tag-tagline"');
    expect(html).toContain(`viewBox="0 0 ${qr.size} ${qr.size}"`);
    expect(html).toContain(qr.d.slice(0, 40));
  });
});

describe("folha A4 frente e verso", () => {
  it("a grade cabe centrada na folha e o verso espelha as colunas", () => {
    expect(SHEET_A4.columns * TAG.widthMm + (SHEET_A4.columns - 1) * SHEET_A4.gapMm + 2 * SHEET_A4_MARGIN.xMm).toBe(SHEET_A4.widthMm);
    expect(SHEET_A4_MARGIN.yMm).toBeGreaterThanOrEqual(5);
    const three = [label(1), label(2), label(3)];
    const back = renderToStaticMarkup(<HangTagSheet labels={three} side="back" storeName="TRIVÉ" />);
    const columns = [...back.matchAll(/grid-column:(\d)/g)].map((match) => match[1]);
    expect(columns).toEqual(["3", "2", "1"]);
    const front = renderToStaticMarkup(<HangTagSheet labels={three} side="front" storeName="TRIVÉ" />);
    expect([...front.matchAll(/grid-column:(\d)/g)].map((match) => match[1])).toEqual(["1", "2", "3"]);
    expect(front.match(/href="#tag-wordmark"/g)).toHaveLength(3);
    expect(front).not.toContain("REF.");
    // Quarta tag desce para a segunda linha, primeira coluna (verso: terceira).
    const four = renderToStaticMarkup(<HangTagSheet labels={[...three, label(4)]} side="back" storeName="TRIVÉ" />);
    expect([...four.matchAll(/grid-row:(\d);grid-column:(\d)/g)].map((match) => `${match[1]}/${match[2]}`)).toEqual(["1/3", "1/2", "1/1", "2/3"]);
  });

  it("frente₁, verso₁, frente₂, verso₂ — duas páginas por folha, sem quebra depois da última", () => {
    const html = renderToStaticMarkup(<HangTagSheets sheets={[[label(1)], [label(2)]]} storeName="TRIVÉ" />);
    const sides = [...html.matchAll(/data-side="(front|back)"/g)].map((match) => match[1]);
    expect(sides).toEqual(["front", "back", "front", "back"]);
    expect(html.match(/class="print-page/g)).toHaveLength(4);
  });
});

describe("gráfica", () => {
  it("duas páginas de 61 × 96 mm por modelo, com a identificação na sangria", () => {
    expect(PRESS_PAGE).toEqual({ widthMm: 61, heightMm: 96 });
    const designs: LabelDesign[] = [
      { ...label(1), quantity: 12 },
      { ...label(2), quantity: 3 },
    ];
    const html = renderToStaticMarkup(<HangTagPress designs={designs} storeName="TRIVÉ" />);
    expect(html.match(/class="print-page/g)).toHaveLength(4);
    expect(html).toContain("DUNAS-AREIA-1 · frente · 12 un.");
    expect(html).toContain("DUNAS-AREIA-1 · verso · 12 un.");
    expect(html).toContain("DUNAS-AREIA-2 · verso · 3 un.");
    expect(html).toContain("width:61mm;height:96mm");
  });

  it("o CSS de impressão fixa o tamanho da página e some com a casca do painel", () => {
    expect(printCss("61mm 96mm")).toContain("size: 61mm 96mm");
    expect(printCss("A4")).toContain("size: A4");
    expect(printCss("A4")).toContain("aside, header, nav");
    expect(printCss("A4")).toContain(".print-page:last-child");
  });
});
