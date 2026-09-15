"use client";

// Os arquivos para o Silhouette Studio: cada folha (frente e verso) vira um
// PNG A4 a 300 dpi capturado da própria prévia (html-to-image: o mesmo HTML
// que a tela mostra, com as fontes embutidas), e as linhas de corte vão
// num DXF pronto (string vinda do servidor). Só apresentação.
import { useState } from "react";

import { Button } from "@/components/ui/form";

/** A4 a 300 dpi. */
const PNG_WIDTH = 2480;
const PNG_HEIGHT = 3508;

function download(name: string, blobOrUrl: Blob | string): void {
  const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== "string") setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function sheetToPng(sheet: HTMLElement): Promise<string> {
  const { toPng } = await import("html-to-image");
  await document.fonts.ready;
  return toPng(sheet, {
    canvasWidth: PNG_WIDTH,
    canvasHeight: PNG_HEIGHT,
    pixelRatio: 1,
    backgroundColor: "#ffffff",
    // O guia das marcas é só da tela.
    filter: (node) => !(node instanceof HTMLElement && node.dataset.guide !== undefined) && !(node instanceof SVGElement && node.hasAttribute("data-guide")),
  });
}

export function SilhouetteDownloads({ sheets, slug, dxf }: { sheets: number; slug: string; dxf: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grabSheet = async (index: number, side: "front" | "back") => {
    const key = `${index}-${side}`;
    setBusy(key);
    setError(null);
    try {
      const sheet = document.querySelector<HTMLElement>(`section.silhouette-sheet[data-sheet="${index}"][data-side="${side}"]`);
      if (!sheet) throw new Error("Folha não encontrada na tela.");
      const png = await sheetToPng(sheet);
      download(`tags-${slug}-folha-${index}-${side === "front" ? "frente" : "verso"}.png`, png);
    } catch (cause) {
      console.error("[etiquetas/silhouette] falha ao gerar o PNG", cause);
      setError("Não consegui gerar o PNG. Recarregue a página e tente de novo (Chrome funciona melhor).");
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
        {Array.from({ length: sheets }, (_, i) => i + 1).map((index) => (
          <span key={index} className="inline-flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => grabSheet(index, "front")}>
              {busy === `${index}-front` ? "Gerando…" : sheets === 1 ? "Baixar frente (PNG)" : `Folha ${index} — frente (PNG)`}
            </Button>
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => grabSheet(index, "back")}>
              {busy === `${index}-back` ? "Gerando…" : sheets === 1 ? "Baixar verso (PNG)" : `Folha ${index} — verso (PNG)`}
            </Button>
          </span>
        ))}
      </div>
      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Cada PNG é a folha A4 inteira a 300 dpi ({PNG_WIDTH} × {PNG_HEIGHT} px), sem marcas — o Studio acrescenta as marcas ao imprimir. A frente é igual em todas as folhas.
      </p>
    </div>
  );
}
