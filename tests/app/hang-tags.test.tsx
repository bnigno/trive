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
import { LabelSheet, SHEET, SHEET_MARGIN } from "@/app/admin/(protected)/produtos/[id]/etiquetas/label-sheet";
import { printCss } from "@/components/print/print-css";
import { SilhouetteSheet } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag-silhouette";
import { silhouetteTagPositions, studioRegistrationMarks } from "@/core/catalog/silhouette";

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

  it("cor/tamanho longos quebram em 2 linhas com corpo menor — o tamanho nunca some", () => {
    const longo = renderToStaticMarkup(<HangTagBack label={{ ...label(1), variantLabel: "Verde-oliva escuro · GG · Estampa floral" }} />);
    expect(longo).toContain("Verde-oliva escuro · GG · Estampa floral");
    expect(longo).toContain("font-size:7.5pt");
    expect(longo).toContain("-webkit-line-clamp:2");
    const curto = renderToStaticMarkup(<HangTagBack label={label(1)} />);
    expect(curto).toContain("font-size:8.5pt");
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

describe("etiqueta adesiva (Pimaco A4355)", () => {
  it("a grade centrada reproduz o gabarito da folha: 3 × 9 de 63,5 × 31 mm, margens 7,15 / 9 mm", () => {
    expect(SHEET).toMatchObject({ columns: 3, rows: 9, labelWidthMm: 63.5, labelHeightMm: 31, gapXMm: 2.6, gapYMm: 0 });
    expect(SHEET_MARGIN.xMm).toBeCloseTo(7.15, 5);
    expect(SHEET_MARGIN.yMm).toBeCloseTo(9, 5);
  });

  it("variação e SKU quebram linha em vez de sumir atrás do preço; o fio cinza não imprime", () => {
    const html = renderToStaticMarkup(
      <LabelSheet labels={[{ ...label(1, "VESTIDO-AUREA-MIDI-VERDE-OLIVA-GG"), variantLabel: "Verde-oliva escuro · GG", priceCents: 129990 }]} />,
    );
    expect(html).toContain("R$\u00a01.299,90");
    expect(html).toContain("padding:9mm 7.15mm");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toContain("text-overflow:ellipsis");
    expect(printCss("A4")).toContain(".label { border-color: transparent !important; }");
  });
});

describe("rodapé da folha A4 (3 × 3)", () => {
  it("com o nome da peça, cada folha diz o número e o lado na sobra de baixo; sem ele, nada muda", () => {
    const html = renderToStaticMarkup(<HangTagSheets sheets={[[label(1)], [label(2)]]} storeName="TRIVÉ" productName="Vestido Dunas" />);
    expect(html).toContain("TRIVÉ · Vestido Dunas · folha 1 de 2 · frente");
    expect(html).toContain("TRIVÉ · Vestido Dunas · folha 2 de 2 · verso");
    expect(html).toContain(`top:${297 - SHEET_A4_MARGIN.yMm + 1.5}mm`);
    expect(renderToStaticMarkup(<HangTagSheets sheets={[[label(1)]]} storeName="TRIVÉ" />)).not.toContain("data-footer");
  });
});

describe("folha para a Silhouette (2 × 2, marcas de registro impressas na frente)", () => {
  const four = [label(1), label(2), label(3), label(4)];
  const positions = silhouetteTagPositions({ widthMm: 55, heightMm: 90 });
  const marks = studioRegistrationMarks();
  const sheet = (props: Partial<Parameters<typeof SilhouetteSheet>[0]> & { side: "front" | "back" }) =>
    renderToStaticMarkup(<SilhouetteSheet labels={four} storeName="TRIVÉ" productName="Vestido Dunas" index={1} total={3} {...props} />);

  it("frente: página de impressão com as três marcas pretas do Studio (quadrado 5 mm, dois L de 20 mm × 0,5 mm), 4 tags nas posições do núcleo e o guia só de tela", () => {
    const html = sheet({ side: "front" });
    expect(html).toContain('class="print-page silhouette-sheet');
    expect(html).toContain('data-side="front"');
    expect(html).toContain('data-sheet="1"');
    expect(html).toContain("data-marks");
    expect(html).toContain(`<rect x="${marks.square.xMm}" y="${marks.square.yMm}" width="5" height="5" fill="#000">`);
    // Cada "L" são dois retângulos cheios com a borda EXTERNA no recuo e 20 mm de perna.
    const tr = marks.topRight;
    expect(html).toContain(`<rect x="${tr.cornerXMm - 20}" y="${tr.cornerYMm}" width="20" height="0.508" fill="#000">`);
    expect(html).toContain(`<rect x="${tr.cornerXMm - 0.508}" y="${tr.cornerYMm}" width="0.508" height="20" fill="#000">`);
    const bl = marks.bottomLeft;
    expect(html).toContain(`<rect x="${bl.cornerXMm}" y="${bl.cornerYMm - 0.508}" width="20" height="0.508" fill="#000">`);
    expect(html).toContain(`<rect x="${bl.cornerXMm}" y="${bl.cornerYMm - 20}" width="0.508" height="20" fill="#000">`);
    // Nada de traço nas marcas: o svg data-marks só tem retângulos cheios.
    const marksSvg = html.slice(html.indexOf("data-marks"), html.indexOf("</svg>", html.indexOf("data-marks")));
    expect(marksSvg).not.toContain("stroke");
    expect(marksSvg.match(/<rect /g)).toHaveLength(5);
    expect(html).toContain("data-guide");
    for (const p of positions) expect(html).toContain(`left:${p.xMm}mm;top:${p.yMm}mm`);
    expect(html.match(/hang-tag-front/g)).toHaveLength(4);
    expect(html).not.toContain("DUNAS-AREIA");
    // Os símbolos vêm uma vez por página (HangTagDefs), não por folha.
    expect(html).not.toContain('id="tag-wordmark"');
  });

  it("verso: sem marcas (o corte lê a frente); a 1ª tag vai para o reflexo físico da sua posição (210 − x − 55), que é a posição da 2ª", () => {
    const html = sheet({ side: "back", index: 2 });
    expect(html).not.toContain("data-marks");
    expect(html).toContain("data-guide");
    const firstBack = html.indexOf("DUNAS-AREIA-1");
    const before = html.slice(0, firstBack);
    const reflected = 210 - positions[0].xMm - 55;
    expect(reflected).toBe(positions[1].xMm);
    expect(before.lastIndexOf(`left:${reflected}mm;top:${positions[0].yMm}mm`)).toBeGreaterThan(before.lastIndexOf(`left:${positions[0].xMm}mm;top:${positions[0].yMm}mm`));
    expect(html.match(/hang-tag-back/g)).toHaveLength(4);
  });

  it("rodapé na sobra inferior diz a folha e o lado, para conferir se a pilha virou certo", () => {
    expect(sheet({ side: "front", index: 2 })).toContain("TRIVÉ · Vestido Dunas · folha 2 de 3 · frente");
    expect(sheet({ side: "back", index: 2 })).toContain("TRIVÉ · Vestido Dunas · folha 2 de 3 · verso");
    expect(sheet({ side: "front" })).toContain("top:288mm");
  });

  it("folha parcial (1 tag) só ocupa a primeira posição", () => {
    const html = sheet({ side: "front", labels: [label(1)] });
    expect(html.match(/hang-tag-front/g)).toHaveLength(1);
    expect(html).toContain(`left:${positions[0].xMm}mm;top:${positions[0].yMm}mm`);
  });

  it("o CSS de impressão esconde o outro lado quando o <html> pede um lado só, e o guia sempre", () => {
    const css = printCss("A4");
    expect(css).toContain('html[data-print-side="front"] .print-page[data-side="back"], html[data-print-side="back"] .print-page[data-side="front"] { display: none !important; }');
    expect(css).toContain("[data-guide] { display: none !important; }");
  });
});
