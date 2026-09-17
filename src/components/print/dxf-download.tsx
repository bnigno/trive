"use client";

// Baixa um arquivo de corte (DXF) que o Silhouette Studio abre — a string
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

export function DxfDownloadButton({ dxf, fileName, label = "Baixar arquivo de corte (DXF)" }: { dxf: string; fileName: string; label?: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => download(fileName, new Blob([dxf], { type: "application/dxf" }))}>
      {label}
    </Button>
  );
}
