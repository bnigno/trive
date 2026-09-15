// CSS de impressão das etiquetas: no papel só as páginas aparecem, uma por
// folha, sem margem do navegador (a margem já está dentro da página). Um
// tamanho de página por documento — dois `@page size` não convivem.
export type PrintPageSize = "A4" | "61mm 96mm";

export function printCss(pageSize: PrintPageSize): string {
  return `@media print {
  aside, header, nav, .print\\:hidden { display: none !important; }
  main { padding: 0 !important; overflow: visible !important; }
  .print-area { display: block !important; padding: 0 !important; margin: 0 !important; background: none !important; border-radius: 0 !important; overflow: visible !important; }
  .print-page { box-shadow: none !important; margin: 0 !important; background: none !important; break-after: page; page-break-after: always; break-inside: avoid; }
  .print-page:last-child { break-after: auto; page-break-after: auto; }
  .label, .label-sheet { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .label { border-color: transparent !important; }
  @page { size: ${pageSize}; margin: 0; }
}`;
}
