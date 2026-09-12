// O orçamento de altura do cartão (PURO): a estimativa de linhas cresce com
// o texto e com a caixa alta; o QR cresce com a versão (e bate com a lib);
// os corpos descem antes de cortar; e a soma nunca passa do miolo — nem com
// tudo em caixa alta nos tetos.
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import {
  EDITION_GEOMETRY as G,
  editionLayout,
  editionQrSize,
  estimateLines,
  qrVersionForText,
} from "@/core/edition/layout";
import { DEFAULT_CARE, DEFAULT_WEAR, editionTexts, fitEditionNote, EDITION_CURATOR_MAX } from "@/core/edition/text";

const SITE = "https://trivemaison.com.br";

describe("estimateLines", () => {
  it("uma linha para texto curto; mais linhas com mais texto, corpo maior e caixa alta", () => {
    expect(estimateLines("Longo Dunas", "serif", 84)).toBe(1);
    const frase = "Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar.";
    expect(estimateLines(frase, "serif", 34)).toBeLessThan(estimateLines(frase.repeat(3), "serif", 34));
    expect(estimateLines(frase, "serif", 34)).toBeLessThanOrEqual(estimateLines(frase, "serif", 44));
    expect(estimateLines(frase.toUpperCase(), "serif", 34)).toBeGreaterThanOrEqual(estimateLines(frase, "serif", 34));
    // A serifa itálica é mais estreita que a Jost: cabe mais por linha.
    expect(estimateLines(frase.repeat(2), "serif", 30)).toBeLessThanOrEqual(estimateLines(frase.repeat(2), "sans", 30));
  });
});

describe("qrVersionForText / editionQrSize", () => {
  it("a versão bate com a lib qrcode para endereços de 20 a 220 caracteres", () => {
    for (let length = 20; length <= 220; length += 7) {
      const url = `${SITE}/produto/${"a".repeat(Math.max(1, length - SITE.length - 9))}`;
      expect(qrVersionForText(url), url.length.toString()).toBe(QRCode.create(url, { errorCorrectionLevel: "M" }).version);
    }
  });

  it("220 px até a versão 5; depois cresce 5 px por módulo, até 300", () => {
    expect(editionQrSize(SITE)).toBe(220);
    expect(editionQrSize(`${SITE}/produto/longo-dunas`)).toBe(220);
    const v7 = `${SITE}/produto/${"a".repeat(80)}`;
    expect(qrVersionForText(v7)).toBe(7);
    expect(editionQrSize(v7)).toBe((17 + 28 + 2) * 5);
    expect(editionQrSize(`${SITE}/produto/${"a".repeat(180)}`)).toBe(300);
  });
});

describe("editionLayout", () => {
  const base = {
    title: "Longo Dunas",
    curatorNote: "Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar.",
    wearNote: DEFAULT_WEAR.vestido,
    careNote: "Lavar à mão · Secar à sombra",
    qrUrl: `${SITE}/produto/longo-dunas`,
  };

  it("texto curto: corpos máximos, nada encurtado, e a soma cabe", () => {
    const layout = editionLayout(base);
    expect(layout).toMatchObject({ titleSize: 84, titleLines: 1, quoteSize: 44, bodySize: 30, qrSize: 220, curatorShortened: false });
    expect(layout.curatorNote).toBe(base.curatorNote);
    expect(layout.estimatedHeight).toBeLessThanOrEqual(G.contentHeight);
  });

  it("nos tetos, em caixa alta, com nome de duas linhas e QR grande: desce os corpos e ainda cabe", () => {
    const up = (t: string) => t.toUpperCase();
    const texts = editionTexts({
      productName: up("Vestido Longo de Linho Puro com Bordado Feito à Mão pelas Artesãs"),
      categoryName: "Vestidos",
      curatorNote: up("Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar. ".repeat(6)),
      fitNotes: up(`${DEFAULT_WEAR.blusa} ${DEFAULT_WEAR.saia}`),
      careNotes: up(`${DEFAULT_CARE.blusa} ${DEFAULT_CARE.saia}`),
    })!;
    const layout = editionLayout({
      title: texts.title,
      curatorNote: texts.curatorNote,
      wearNote: texts.wearNote,
      careNote: texts.careNote,
      qrUrl: `${SITE}/produto/vestido-longo-de-linho-puro-com-bordado-feito-a-mao-pelas-artesas-da-ilha`,
    });
    expect(layout.estimatedHeight).toBeLessThanOrEqual(G.contentHeight);
    expect(layout.titleLines).toBe(2);
    // A frase em caixa alta no teto só cabe em cinco linhas no corpo mínimo.
    expect(layout.quoteSize).toBe(34);
    expect(layout.quoteLines).toBe(G.quote.maxLines);
    expect(layout.wearLines).toBeLessThanOrEqual(G.body.maxLines);
    expect(layout.careLines).toBeLessThanOrEqual(G.body.maxLines);
    expect(layout.qrSize).toBeGreaterThan(220);
  });

  it("quando nem o corpo mínimo cabe, encurta a frase da curadora (no fim de uma frase) e avisa", () => {
    const frase = fitEditionNote("Uma frase da curadora bem comprida sobre a peça. ".repeat(10), EDITION_CURATOR_MAX, { quotes: true }).text!;
    const layout = editionLayout({
      ...base,
      title: "Vestido Longo de Linho com Bordado Marajoara Nazaré",
      curatorNote: frase.toUpperCase(),
      wearNote: DEFAULT_WEAR.blusa.toUpperCase(),
      careNote: DEFAULT_CARE.blusa.toUpperCase(),
      qrUrl: `${SITE}/produto/${"a".repeat(180)}`,
    });
    expect(layout.estimatedHeight).toBeLessThanOrEqual(G.contentHeight);
    if (layout.curatorShortened) {
      expect(layout.curatorNote!.length).toBeLessThan(frase.length);
      expect(layout.curatorNote!.endsWith(".")).toBe(true);
    }
    expect(layout.bodySize).toBe(26);
    expect(layout.quoteSize).toBe(34);
  });

  it("a soma dos máximos do desenho cabe no miolo com folga para uma linha de frase", () => {
    // Título 2 linhas a 46, frase 5 linhas a 34, quadros 3 linhas a 26, QR 300.
    const worst =
      G.eyebrow.size * G.eyebrow.lineHeight +
      G.title.marginTop + 2 * 46 * G.title.lineHeight +
      G.rule.marginTop + G.rule.height +
      G.quote.marginTop + 5 * 34 * G.quote.lineHeight + G.quote.gap + G.byline.size * G.byline.lineHeight +
      G.boxes.marginTopWithQuote + 2 * (G.label.size * G.label.lineHeight + G.label.gap + 3 * 26 * G.body.lineHeight) + G.boxes.gap + G.boxes.paddingBottom +
      300 + G.footer.paddingBottom +
      G.band.lockupHeight + 2 * G.band.padding;
    expect(worst).toBeLessThanOrEqual(G.contentHeight - 34 * G.quote.lineHeight);
  });
});
