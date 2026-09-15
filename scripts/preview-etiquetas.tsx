// Prévia das tags de cabide sem banco: monta as páginas (folha A4 frente e
// verso e o arquivo de gráfica) em HTML estático com as fontes da marca e,
// se o Chrome estiver no lugar de sempre, gera os PDFs e um PNG e confere
// tamanho de página, número de páginas e a leitura do QR.
// Uso: npx tsx scripts/preview-etiquetas.tsx [pasta-de-saida]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { HangTagDefs } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag";
import { HangTagPress } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag-press";
import { HangTagSheets } from "@/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag-sheets";
import { printCss } from "@/app/admin/(protected)/produtos/[id]/etiquetas/print-css";
import { planProductLabels } from "@/core/catalog/labels";
import { qrSvgPath } from "@/receipts/qr";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PRODUCT_URL = "https://trivemaison.com.br/produto/longo-dunas";

function fontFace(family: string, file: string, weight: number, style = "normal"): string {
  const url = pathToFileURL(resolve("brand-source/fonts/subset", file)).href;
  return `@font-face { font-family: "${family}"; src: url("${url}") format("truetype"); font-weight: ${weight}; font-style: ${style}; }`;
}

function document(title: string, css: string, body: string): string {
  const brand = pathToFileURL(resolve("public")).href;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><style>
${fontFace("Cormorant Garamond", "CormorantGaramond-SemiBold.ttf", 600)}
${fontFace("Cormorant Garamond", "CormorantGaramond-Italic.ttf", 400, "italic")}
${fontFace("Jost", "Jost-Regular.ttf", 400)}
${fontFace("Jost", "Jost-Medium.ttf", 500)}
body { margin: 0; background: #e5e5e5; }
.print-area { --font-cormorant: "Cormorant Garamond"; --font-jost: "Jost"; display: flex; flex-direction: column; gap: 24px; padding: 24px; }
.print-page { box-shadow: 0 2px 12px rgba(0,0,0,.2); }
${css}
</style></head><body><div class="print-area">${body.replaceAll('src="/brand/', `src="${brand}/brand/`)}</div></body></html>`;
}

function pdfInfo(file: string): { pages: number; boxes: string[] } {
  const bytes = readFileSync(file, "latin1");
  const pages = (bytes.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  const boxes = [...bytes.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => `${m[1]}×${m[2]}`);
  return { pages, boxes: [...new Set(boxes)] };
}

async function main() {
  const out = process.argv[2] ?? ".preview";
  mkdirSync(out, { recursive: true });

  // Inclui casos extremos: cor composta com 3 eixos, SKU longo, composição de 2 linhas.
  const variants = [
    { id: "11111111-1111-4111-8111-111111111111", sku: "DUNAS-AREIA-P", attributes: { cor: "Areia", tamanho: "P", estampa: "Lisa" }, isActive: true, priceCents: 28900 },
    { id: "22222222-2222-4222-8222-222222222222", sku: "DUNAS-AREIA-M", attributes: { cor: "Areia", tamanho: "M", estampa: "Lisa" }, isActive: true, priceCents: 28900 },
    { id: "33333333-3333-4333-8333-333333333333", sku: "VESTIDO-LONGO-DUNAS-OLIVA-ESCURO-GG", attributes: { cor: "Verde-oliva escuro", tamanho: "GG", estampa: "Floral miúda" }, isActive: true, priceCents: 28900 },
  ];
  const plan = planProductLabels({
    model: "cabide",
    storeName: "TRIVÉ",
    productName: "Macacão Pantalona Alfaiataria Amêndoa Premium",
    composition: "100% linho · forro 100% viscose · botões de madrepérola",
    productUrl: PRODUCT_URL,
    axes: ["cor", "tamanho", "estampa"],
    variants,
    quantities: { [variants[0].id]: 9, [variants[1].id]: 8, [variants[2].id]: 3 },
  });
  const qr = qrSvgPath(PRODUCT_URL);
  const defs = renderToStaticMarkup(<HangTagDefs qr={qr} />);

  const a4 = join(out, "etiquetas-a4.html");
  writeFileSync(a4, document("Tags A4", printCss("A4"), defs + renderToStaticMarkup(<HangTagSheets sheets={plan.sheets} storeName="TRIVÉ" />)));
  const press = join(out, "etiquetas-grafica.html");
  writeFileSync(press, document("Tags gráfica", printCss("61mm 96mm"), defs + renderToStaticMarkup(<HangTagPress designs={plan.designs} storeName="TRIVÉ" />)));
  console.log(`html: ${a4}, ${press} (${plan.labels.length} tags, ${plan.sheets.length} folhas, ${plan.designs.length} modelos)`);

  if (!existsSync(CHROME)) {
    console.log("Chrome não encontrado: abra os HTML e use Imprimir → Salvar como PDF.");
    return;
  }
  for (const [name, html, expectPages, expectBox] of [
    ["etiquetas-a4", a4, plan.sheets.length * 2, "595.276×841.89"],
    ["etiquetas-grafica", press, plan.designs.length * 2, "172.913×272.126"],
  ] as const) {
    const pdf = resolve(out, `${name}.pdf`);
    execFileSync(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--virtual-time-budget=8000",
      `--print-to-pdf=${pdf}`,
      pathToFileURL(resolve(html)).href,
    ], { stdio: "ignore" });
    const info = pdfInfo(pdf);
    // O Chrome arredonda a página a 1/96 pol: tolerância de 1 pt.
    const [expectW, expectH] = expectBox.split("×").map(Number);
    const [gotW, gotH] = (info.boxes[0] ?? "0×0").split("×").map(Number);
    const ok = info.pages === expectPages && info.boxes.length === 1 && Math.abs(gotW - expectW) < 1 && Math.abs(gotH - expectH) < 1;
    console.log(`${ok ? "ok" : "CONFIRA"}: ${pdf} → ${info.pages} páginas (esperado ${expectPages}), MediaBox ${info.boxes.join(", ")} (esperado ≈ ${expectBox} pt)`);
  }
  const png = resolve(out, "etiquetas-a4.png");
  execFileSync(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=900,2400",
    "--virtual-time-budget=8000",
    `--screenshot=${png}`,
    pathToFileURL(resolve(a4)).href,
  ], { stdio: "ignore" });
  console.log(`png: ${png}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
