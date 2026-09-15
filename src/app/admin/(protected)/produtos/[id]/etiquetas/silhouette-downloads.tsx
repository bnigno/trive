"use client";

// Os arquivos para o Silhouette Studio: cada folha (frente e verso) vira um
// PNG A4 a 300 dpi capturado da própria prévia (modern-screenshot: o mesmo
// HTML que a tela mostra, fontes embutidas, sem o arredondamento de
// font-size do html-to-image), com o DPI gravado no arquivo (chunk pHYs)
// para o Studio já abrir em 210 × 297 mm; as linhas de corte vão em DXF
// pronto (string vinda do servidor). Só apresentação.
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/form";

/** A4 a 300 dpi. */
const PNG_WIDTH = 2480;
const PNG_HEIGHT = 3508;
const PX_PER_MM_300DPI = 300 / 25.4;
/** O tamanho CSS exato da folha (96 dpi): o clone é medido com isso, não com clientWidth inteiro. */
const CSS_WIDTH = (210 * 96) / 25.4;
const CSS_HEIGHT = (297 * 96) / 25.4;

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Grava a resolução (300 dpi) no PNG: o Studio abre a imagem já em 210 × 297 mm. */
function withDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  if (png.length < ihdrEnd || String.fromCharCode(...png.subarray(12, 16)) !== "IHDR") return png;
  const perMeter = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMeter);
  view.setUint32(12, perMeter);
  chunk[16] = 1; // metro
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

async function sheetToPng(sheet: HTMLElement): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  await document.fonts.ready;
  const blob = await domToBlob(sheet, {
    width: CSS_WIDTH,
    height: CSS_HEIGHT,
    // Escala pela altura (arredondamento por piso): 2480 × 3508 exatos.
    scale: PNG_HEIGHT / CSS_HEIGHT + 1e-4,
    backgroundColor: "#ffffff",
    type: "image/png",
    // O guia das marcas e dos contornos é só da tela.
    filter: (node) => !(node instanceof Element && node.hasAttribute("data-guide")),
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const stamped = withDpi(bytes, 300);
  return new Blob([stamped.buffer.slice(stamped.byteOffset, stamped.byteOffset + stamped.byteLength) as ArrayBuffer], { type: "image/png" });
}

const noop = () => () => {};
/** O Safari rasteriza o foreignObject sem as fontes/imagens na primeira vez, em silêncio: melhor não deixar. */
function useIsSafari(): boolean {
  return useSyncExternalStore(noop, () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent), () => false);
}

export function SilhouetteDownloads({ sheets, lastSheetCount, slug, dxf, dxfLastSheet }: { sheets: number; lastSheetCount: number; slug: string; dxf: string; dxfLastSheet: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSafari = useIsSafari();

  const grabSheet = async (index: number, side: "front" | "back") => {
    const key = `${index}-${side}`;
    setBusy(key);
    setError(null);
    try {
      const sheet = document.querySelector<HTMLElement>(`section.silhouette-sheet[data-sheet="${index}"][data-side="${side}"]`);
      if (!sheet) throw new Error("Folha não encontrada na tela.");
      download(`tags-${slug}-folha-${index}-${side === "front" ? "frente" : "verso"}.png`, await sheetToPng(sheet));
    } catch (cause) {
      console.error("[etiquetas/silhouette] falha ao gerar o PNG", cause);
      setError("Não consegui gerar o PNG. Recarregue a página e tente de novo no Chrome.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => download("tags-corte-silhouette.dxf", new Blob([dxf], { type: "application/dxf" }))}>
          Baixar linhas de corte (DXF)
        </Button>
        {dxfLastSheet ? (
          <Button type="button" variant="outline" size="sm" onClick={() => download(`tags-corte-silhouette-ultima-folha-${lastSheetCount}.dxf`, new Blob([dxfLastSheet], { type: "application/dxf" }))}>
            DXF da última folha ({lastSheetCount} {lastSheetCount === 1 ? "tag" : "tags"})
          </Button>
        ) : null}
        {Array.from({ length: sheets }, (_, i) => i + 1).map((index) => (
          <span key={index} className="inline-flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy !== null || isSafari} onClick={() => grabSheet(index, "front")}>
              {busy === `${index}-front` ? "Gerando…" : sheets === 1 ? "Baixar frente (PNG)" : `Folha ${index} — frente (PNG)`}
            </Button>
            <Button type="button" size="sm" disabled={busy !== null || isSafari} onClick={() => grabSheet(index, "back")}>
              {busy === `${index}-back` ? "Gerando…" : sheets === 1 ? "Baixar verso (PNG)" : `Folha ${index} — verso (PNG)`}
            </Button>
          </span>
        ))}
      </div>
      {isSafari ? <p className="text-sm text-amber-800 dark:text-amber-200">Gere os PNGs no <strong>Chrome</strong>: o Safari entrega a imagem sem as fontes e sem o monograma, sem avisar. O DXF pode baixar aqui mesmo.</p> : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Cada PNG é a folha A4 inteira a 300 dpi ({PNG_WIDTH} × {PNG_HEIGHT} px, {Math.round(PX_PER_MM_300DPI * 100) / 100} px/mm, com a resolução gravada no arquivo), sem marcas — o Studio acrescenta as marcas ao imprimir. A frente é igual em todas as folhas.
      </p>
    </div>
  );
}
