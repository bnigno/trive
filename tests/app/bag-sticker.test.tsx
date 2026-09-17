// O adesivo da sacola (15 × 10): só apresentação, renderizada com
// react-dom/server — o que sai no papel é o que se afirma aqui.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BAG_ART, BAG_QR_SYMBOL, BagQrSymbol, BagSticker, BagStickerSheet, type BagStickerData } from "@/app/admin/(protected)/produtos/selos/bag-sticker";
import { PAGE_A4, silhouetteSafeArea, studioRegistrationMarks } from "@/core/catalog/silhouette";
import { BAG_STICKER, gridPositions, PLAIN_SHEET_MARGIN_MM, printableArea } from "@/core/print/round-labels";
import { qrSvgPath, qrVersion } from "@/receipts/qr";

const data: BagStickerData = {
  storeName: "TRIVÉ",
  storeLine: "Para a mulher que se veste de si.",
  whatsappE164: "+5591980673536",
  instagram: "@trive_mfeminine",
  siteHost: "trivemaison.com.br",
  sellerName: "Lia",
};

describe("BagSticker (150 × 100)", () => {
  it("modo tesoura: base marfim com sangria, moldura dupla dourada, marcas de corte, marca completa, QR, contatos e agradecimento", () => {
    const html = renderToStaticMarkup(<BagSticker data={data} mode="scissors" />);
    expect(html).toContain('class="seal bag-sticker"');
    expect(html).toContain("width:150mm;height:100mm");
    expect(html).toContain("print-color-adjust:exact");
    // Base com 1 mm de sangria (retângulo cheio na tesoura) e moldura dupla.
    expect(html).toContain('viewBox="-1 -1 152 102"');
    expect(html).toContain('<rect x="-1" y="-1" width="152" height="102" fill="#faf7f0">');
    expect(html).toContain(`<rect x="${BAG_ART.frameInsetMm}" y="${BAG_ART.frameInsetMm}" width="142" height="92" rx="4" ry="4" fill="none" stroke="#6f561b" stroke-width="${BAG_ART.frameStrokeMm}">`);
    expect(html).toContain(`stroke-width="${BAG_ART.frameInnerStrokeMm}"`);
    expect(html).toContain("data-crop-marks");
    expect(html).not.toContain("data-marks");
    // Marca: monograma, letreiro, tagline e a frase da vitrine.
    expect(html).toContain("/brand/mark-light-800.webp");
    expect(html).toContain(`height:${BAG_ART.monogramHeightMm}mm`);
    expect(html).toContain('href="#tag-wordmark"');
    expect(html).toContain('href="#tag-tagline"');
    expect(html).toContain("Para a mulher que se veste de si.");
    // Caminho de volta: QR de 28 mm, telefone formatado, Instagram em destaque, site, envio, agradecimento.
    expect(html).toContain(`href="#${BAG_QR_SYMBOL}"`);
    expect(html).toContain(`width:${BAG_ART.qrSizeMm}mm;height:${BAG_ART.qrSizeMm}mm`);
    expect(html).toContain("Fale com a Lia");
    expect(html).toMatch(/data-whatsapp=""[^>]*>\(91\) 98067-3536</);
    expect(html).toMatch(/data-instagram=""[^>]*font-size:12pt/);
    expect(html).toContain(">@trive_mfeminine<");
    expect(html).toMatch(/data-site=""[^>]*>trivemaison\.com\.br</);
    expect(html).toContain("envio para todo o Brasil");
    expect(html).toContain("Obrigada por levar a gente com você.");
    expect(html).not.toContain("qualquer hora");
  });

  it("modo Silhouette: base com cantos arredondados (r 7 com a sangria), sem marcas de corte", () => {
    const html = renderToStaticMarkup(<BagSticker data={data} mode="silhouette" />);
    expect(html).toContain('<rect x="-1" y="-1" width="152" height="102" rx="7" ry="7" fill="#faf7f0">');
    expect(html).not.toContain("data-crop-marks");
  });

  it("frase da vitrine longa desce para 9 pt; nome de loja longo fora do letreiro encolhe", () => {
    const long = "Vestir é um jeito de contar quem você é — sem precisar dizer uma palavra, todos os dias.";
    const html = renderToStaticMarkup(<BagSticker data={{ ...data, storeLine: long, storeName: "Ateliê da Marina" }} mode="scissors" />);
    expect(html).toMatch(/data-store-line=""[^>]*font-size:9pt/);
    expect(html).toMatch(/font-size:12pt;letter-spacing:0.3em[^>]*>Ateliê da Marina</);
    expect(html).toContain("Obrigada por levar a gente com você.");
  });

  it("sem WhatsApp: sem QR e sem a linha do telefone; Instagram e site continuam", () => {
    const html = renderToStaticMarkup(<BagSticker data={{ ...data, whatsappE164: null }} mode="scissors" />);
    expect(html).not.toContain(`href="#${BAG_QR_SYMBOL}"`);
    expect(html).not.toContain("data-whatsapp");
    expect(html).toContain(">@trive_mfeminine<");
    expect(html).toMatch(/data-site=""[^>]*>trivemaison\.com\.br</);
  });

  it("o QR do wa.me da loja cabe em 28 mm (versão ≤ 7) e o símbolo carrega o path", () => {
    const text = "https://wa.me/5591980673536?text=Oi%2C%20Lia!%20Vim%20pela%20sacola%20da%20TRIV%C3%89";
    expect(qrVersion(text)).toBeLessThanOrEqual(7);
    const qr = qrSvgPath(text);
    const html = renderToStaticMarkup(<svg><defs><BagQrSymbol qr={qr} /></defs></svg>);
    expect(html).toContain(`<symbol id="${BAG_QR_SYMBOL}" viewBox="0 0 ${qr.size} ${qr.size}">`);
    expect(html).toContain('shape-rendering="crispEdges"');
  });
});

describe("BagStickerSheet", () => {
  it("papel comum: 2 por folha, sem marcas de registro; Silhouette: 2 com as marcas", () => {
    const plain = gridPositions({ cellWidthMm: BAG_STICKER.widthMm, cellHeightMm: BAG_STICKER.heightMm, gapMm: BAG_STICKER.gapMm, area: printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM) });
    const a4 = renderToStaticMarkup(<BagStickerSheet positions={plain} data={data} mode="scissors" index={1} total={2} />);
    expect(a4.match(/class="seal bag-sticker"/g)).toHaveLength(2);
    expect(a4).not.toContain("data-marks");
    expect(a4).toContain("TRIVÉ · adesivo da sacola · folha 1 de 2");
    expect(a4).toContain(`left:${plain[0].xMm}mm;top:${plain[0].yMm}mm`);

    const safe = silhouetteSafeArea(PAGE_A4);
    const cut = gridPositions({ cellWidthMm: BAG_STICKER.widthMm, cellHeightMm: BAG_STICKER.heightMm, gapMm: BAG_STICKER.gapMm, area: safe, centerIn: { xMm: safe.xMm, yMm: 0, widthMm: safe.widthMm, heightMm: PAGE_A4.heightMm } });
    const silhouette = renderToStaticMarkup(<BagStickerSheet positions={cut} data={data} mode="silhouette" index={1} total={1} />);
    expect(silhouette.match(/class="seal bag-sticker"/g)).toHaveLength(2);
    const marks = studioRegistrationMarks(PAGE_A4);
    expect(silhouette).toContain(`<rect x="${marks.square.xMm}" y="${marks.square.yMm}" width="5" height="5" fill="#000">`);
  });
});
