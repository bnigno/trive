// CSS de impressão das etiquetas: no papel só as páginas aparecem, uma por
// folha, sem margem do navegador (a margem já está dentro da página). Um
// tamanho de página por documento — dois `@page size` não convivem.
// `data-print-side` no <html> (posto pelos botões "Imprimir frentes/versos")
// deixa no papel só as páginas daquele lado: a impressora que não vira papel
// grosso imprime todas as frentes, a pilha vira, e depois todos os versos.
export type PrintPageSize = "A4" | "61mm 96mm";

export function printCss(pageSize: PrintPageSize): string {
  return `@media print {
  aside, header, nav, .print\\:hidden { display: none !important; }
  main { padding: 0 !important; overflow: visible !important; }
  .print-area { display: block !important; padding: 0 !important; margin: 0 !important; background: none !important; border-radius: 0 !important; overflow: visible !important; }
  .print-page { box-shadow: none !important; margin: 0 !important; background: none !important; break-after: page; page-break-after: always; break-inside: avoid; }
  .print-page:last-child { break-after: auto; page-break-after: auto; }
  html[data-print-side="front"] .print-page[data-side="back"], html[data-print-side="back"] .print-page[data-side="front"] { display: none !important; }
  [data-guide] { display: none !important; }
  .label, .label-sheet { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .label { border-color: transparent !important; }
  @page { size: ${pageSize}; margin: 0; }
}`;
}
