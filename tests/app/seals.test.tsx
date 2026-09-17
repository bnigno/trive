// O selo de embalagem (50 mm) e a folha: só apresentação, renderizada com
// react-dom/server — o que sai no papel é o que se afirma aqui.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Seal, SEAL_ART, SealSheet } from "@/app/admin/(protected)/produtos/selos/seal";
import { BrandLetteringDefs } from "@/components/print/brand-lettering";
import { printCss } from "@/components/print/print-css";
import { PAGE_A4, silhouetteSafeArea, studioRegistrationMarks } from "@/core/catalog/silhouette";
import { PLAIN_SHEET_MARGIN_MM, printableArea, roundLabelPositions, SEAL } from "@/core/print/round-labels";

describe("Seal (50 mm)", () => {
  it("modo tesoura: disco marfim até o corte, anel duplo dourado, fio-guia, monograma, letreiro e tagline com filetes", () => {
    const html = renderToStaticMarkup(<Seal storeName="TRIVÉ" mode="scissors" />);
    expect(html).toContain('class="seal"');
    expect(html).toContain("width:50mm;height:50mm");
    expect(html).toContain("print-color-adjust:exact");
    // Disco do tamanho do corte (r 25), sem sangria.
    expect(html).toContain('viewBox="0 0 50 50"');
    expect(html).toContain(`<circle cx="25" cy="25" r="25" fill="#faf7f0">`);
    expect(html).toContain(`r="${SEAL_ART.ringOuterRadiusMm}" fill="none" stroke="#6f561b" stroke-width="${SEAL_ART.ringOuterStrokeMm}"`);
    expect(html).toContain(`r="${SEAL_ART.ringInnerRadiusMm}" fill="none" stroke="#6f561b" stroke-width="${SEAL_ART.ringInnerStrokeMm}"`);
    expect(html).toContain("data-cut-guide");
    expect(html).toContain('stroke="#aba28e"');
    expect(html).toContain("/brand/mark-light-800.webp");
    expect(html).toContain(`height:${SEAL_ART.monogramHeightMm}mm`);
    expect(html).toContain('href="#tag-wordmark"');
    expect(html).toContain('href="#tag-tagline"');
    expect(html).toContain('aria-label="Maison Féminine"');
    expect(html.match(/border-top:0\.25mm solid #865749/g)).toHaveLength(2);
    // Sem texto além do logotipo e do slogan.
    expect(html).not.toContain("REF.");
  });

  it("modo Silhouette: o disco sangra 1 mm além do corte e não há fio-guia", () => {
    const html = renderToStaticMarkup(<Seal storeName="TRIVÉ" mode="silhouette" />);
    expect(html).toContain('viewBox="-1 -1 52 52"');
    expect(html).toContain(`<circle cx="25" cy="25" r="26" fill="#faf7f0">`);
    expect(html).toContain("left:-1mm;top:-1mm;width:52mm;height:52mm");
    expect(html).not.toContain("data-cut-guide");
  });

  it("nome de loja fora do letreiro cai no nome em Cormorant", () => {
    const html = renderToStaticMarkup(<Seal storeName="Outra Loja" mode="scissors" />);
    expect(html).not.toContain('href="#tag-wordmark"');
    expect(html).toContain("Outra Loja");
    expect(html).toContain("Cormorant Garamond");
  });
});

describe("SealSheet", () => {
  const scissors = roundLabelPositions({ diameterMm: SEAL.diameterMm, gapMm: SEAL.gapMm, area: printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM) });
  const silhouette = roundLabelPositions({ diameterMm: SEAL.diameterMm, gapMm: SEAL.gapMm, area: silhouetteSafeArea(PAGE_A4) });

  it("papel comum: 15 selos, sem marcas de registro, rodapé com a folha", () => {
    const html = renderToStaticMarkup(<SealSheet positions={scissors} storeName="TRIVÉ" mode="scissors" index={2} total={3} />);
    expect(html).toContain('class="print-page seal-sheet');
    expect(html.match(/class="seal"/g)).toHaveLength(15);
    expect(html).not.toContain("data-marks");
    expect(html).toContain("TRIVÉ · selos de embalagem · folha 2 de 3");
    // Cada selo posicionado pelo canto (centro − 25).
    expect(html).toContain(`left:${scissors[0].cxMm - 25}mm;top:${scissors[0].cyMm - 25}mm`);
  });

  it("Silhouette: 12 selos e as três marcas de registro nas coordenadas do Studio", () => {
    const html = renderToStaticMarkup(<SealSheet positions={silhouette} storeName="TRIVÉ" mode="silhouette" index={1} total={1} />);
    expect(html.match(/class="seal"/g)).toHaveLength(12);
    expect(html).toContain("data-marks");
    const marks = studioRegistrationMarks(PAGE_A4);
    expect(html).toContain(`<rect x="${marks.square.xMm}" y="${marks.square.yMm}" width="5" height="5" fill="#000">`);
  });

  it("o CSS de impressão imprime o fundo do selo e os símbolos do letreiro existem uma vez por página", () => {
    expect(printCss("A4")).toContain(".seal { print-color-adjust: exact");
    const defs = renderToStaticMarkup(<BrandLetteringDefs />);
    expect(defs).toContain('id="tag-wordmark"');
    expect(defs).toContain('id="tag-tagline"');
    expect(defs).not.toContain('id="tag-qr"');
  });
});
