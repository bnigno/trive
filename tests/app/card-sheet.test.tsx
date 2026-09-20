// A folha dos cartões da edição: só apresentação, renderizada com
// react-dom/server — o que sai no papel é o que se afirma aqui.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CardSheet, PlacedImage, SILHOUETTE_IMAGE_INSET_MM } from "@/app/admin/(protected)/pedidos/[id]/cartoes/card-sheet";
import { EDITION_PAPER } from "@/core/edition/layout";
import { planEditionSheets } from "@/core/print/edition-sheets";

const LETTER = { key: "carta", kind: "letter" as const, url: "https://cdn/carta.jpg", alt: "Carta de estreia para Ana" };
const CARDS = [
  { key: "c1", kind: "card" as const, url: "https://cdn/c1.jpg", alt: "Cartão da edição: Vestido Íris" },
  { key: "c2", kind: "card" as const, url: "https://cdn/c2.jpg", alt: "Cartão da edição: Blusa Brisa" },
  { key: "c3", kind: "card" as const, url: "https://cdn/c3.jpg", alt: "Cartão da edição: Saia Sol" },
];

describe("PlacedImage", () => {
  const [sheet] = planEditionSheets({ letter: null, cards: CARDS.slice(0, 1), format: "a4" });
  const card = sheet.items[0];

  it("tesoura: base marfim retangular 1 mm maior (92 × 122, a cor dos JPEGs), imagem exata 90 × 120 sem recuo, marcas de corte, sem marcas de registro", () => {
    const html = renderToStaticMarkup(<PlacedImage item={card} mode="scissors" />);
    expect(html).toContain('data-item="card"');
    expect(html).toContain("left:12mm;top:25.5mm;width:90mm;height:120mm");
    expect(html).toContain('viewBox="-1 -1 92 122"');
    expect(html).toContain(`<rect x="-1" y="-1" width="92" height="122" fill="${EDITION_PAPER}">`);
    expect(EDITION_PAPER).toBe("#fdfbf6");
    expect(html).toContain("left:0mm;top:0mm;width:90mm;height:120mm;overflow:hidden;border-radius:0");
    expect(html).toContain('src="https://cdn/c1.jpg"');
    expect(html).toContain('alt="Cartão da edição: Vestido Íris"');
    expect(html).toContain("left:0mm;top:0mm;width:90mm;height:120mm;display:block");
    expect(html).toContain("data-crop-marks");
    expect(html).not.toContain("data-marks");
  });

  it("Silhouette: base com cantos r 6 (5 + sangria), imagem recuada 0,3 mm num quadro com border-radius 5 mm (a hairline some), sem marcas de corte", () => {
    const html = renderToStaticMarkup(<PlacedImage item={card} mode="silhouette" />);
    expect(SILHOUETTE_IMAGE_INSET_MM).toBe(0.3);
    expect(html).toContain(`<rect x="-1" y="-1" width="92" height="122" rx="6" ry="6" fill="${EDITION_PAPER}">`);
    expect(html).toContain("left:0.3mm;top:0.3mm;width:89.4mm;height:119.4mm;overflow:hidden;border-radius:5mm");
    expect(html).toContain("left:-0.3mm;top:-0.3mm;width:90mm;height:120mm");
    expect(html).not.toContain("data-crop-marks");
  });
});

describe("CardSheet", () => {
  it("A4 mista: carta 152 × 102 em (30, 45,5) e 2 cartões em (12/108, 151,5); rodapé; sem marcas de registro", () => {
    const [mixed] = planEditionSheets({ letter: LETTER, cards: CARDS, format: "a4" });
    const html = renderToStaticMarkup(<CardSheet sheet={mixed} mode="scissors" index={1} total={2} storeName="TRIVÉ" orderNumber={1010} />);
    expect(html).toContain('class="print-page card-sheet w-fit shrink-0 shadow-md"');
    expect(html).toContain('data-mode="scissors"');
    expect(html).toContain('data-kind="mixed"');
    expect(html).toContain("width:210mm;height:297mm");
    expect(html).toContain("print-color-adjust:exact");
    expect(html).toContain('data-item="letter" style="position:absolute;left:30mm;top:45.5mm;width:150mm;height:100mm"');
    expect(html).toContain('viewBox="-1 -1 152 102"');
    expect(html).toContain('data-item="card" style="position:absolute;left:12mm;top:151.5mm;width:90mm;height:120mm"');
    expect(html).toContain('data-item="card" style="position:absolute;left:108mm;top:151.5mm;width:90mm;height:120mm"');
    expect(html.match(/data-crop-marks/g)).toHaveLength(3);
    expect(html).not.toContain("data-marks");
    expect(html).toContain("TRIVÉ · cartões do pedido #1010 · folha 1 de 2");
    expect(html).toContain("top:290mm");
  });

  it("Silhouette: marcas de registro, carta sozinha na primeira folha (36,61, 45,5), cartões em (66,61; 26,5/150,5)", () => {
    const sheets = planEditionSheets({ letter: LETTER, cards: CARDS, format: "silhouette" });
    expect(sheets).toHaveLength(3);
    const letterHtml = renderToStaticMarkup(<CardSheet sheet={sheets[0]} mode="silhouette" index={1} total={3} storeName="TRIVÉ" orderNumber={1010} />);
    expect(letterHtml).toContain('data-kind="letter"');
    expect(letterHtml).toContain("data-marks");
    expect(letterHtml).toContain('data-item="letter" style="position:absolute;left:36.61mm;top:45.5mm;width:150mm;height:100mm"');
    expect(letterHtml).toContain('rx="7" ry="7"');
    expect(letterHtml).toContain("border-radius:6mm");
    expect(letterHtml).not.toContain("data-crop-marks");

    const cardsHtml = renderToStaticMarkup(<CardSheet sheet={sheets[1]} mode="silhouette" index={2} total={3} storeName="TRIVÉ" orderNumber={1010} />);
    expect(cardsHtml).toContain('data-item="card" style="position:absolute;left:66.61mm;top:26.5mm;width:90mm;height:120mm"');
    expect(cardsHtml).toContain('data-item="card" style="position:absolute;left:66.61mm;top:150.5mm;width:90mm;height:120mm"');
    expect(cardsHtml).toContain("folha 2 de 3");
  });
});
