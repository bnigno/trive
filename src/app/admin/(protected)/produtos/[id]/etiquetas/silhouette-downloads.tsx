"use client";

import { DxfDownloadButton } from "@/components/print/dxf-download";

export function SilhouetteDownloads({ dxf }: { dxf: string }) {
  return (
    <div className="flex flex-wrap gap-3">
      <DxfDownloadButton dxf={dxf} fileName="tags-corte-silhouette.dxf" />
    </div>
  );
}
