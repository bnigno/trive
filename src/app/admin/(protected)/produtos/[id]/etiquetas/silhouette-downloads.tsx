"use client";

// Baixa o arquivo de corte (DXF) que o Silhouette Studio abre — a string
// vem pronta do servidor (núcleo). Só apresentação.
import { Button } from "@/components/ui/form";

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revogar na hora cancela o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function SilhouetteDownloads({ dxf }: { dxf: string }) {
  return (
    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="outline" size="sm" onClick={() => download("tags-corte-silhouette.dxf", new Blob([dxf], { type: "application/dxf" }))}>
        Baixar arquivo de corte (DXF)
      </Button>
    </div>
  );
}
