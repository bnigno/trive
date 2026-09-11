// "Medidas (cm)": tabela tamanho × medida, só com as colunas que têm valor.
import {
  columnsPresent,
  MEASUREMENT_LABELS,
  type SizeChartRow,
} from "@/core/catalog/measurements";

function formatCm(value: number | undefined): string {
  if (value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
}

export function SizeChartTable({ chart }: { chart: SizeChartRow[] }) {
  const columns = columnsPresent(chart);
  if (chart.length === 0 || columns.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] border-collapse font-store text-[15px] tabular-nums">
          <thead>
            <tr className="border-b border-ivory-300 text-left">
              <th scope="col" className="py-2 pr-4 text-eyebrow font-medium text-ink-500 uppercase">
                Tamanho
              </th>
              {columns.map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="py-2 pr-4 text-eyebrow font-medium text-ink-500 uppercase"
                >
                  {MEASUREMENT_LABELS[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.map((row) => (
              <tr key={row.size} className="border-b border-ivory-200 last:border-0">
                <th scope="row" className="py-2 pr-4 text-left font-semibold text-espresso-900">
                  {row.size}
                </th>
                {columns.map((key) => (
                  <td key={key} className="py-2 pr-4 text-ink-700">
                    {formatCm(row.measurements[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-store text-sm text-ink-500">
        Medidas da peça deitada, em centímetros. Em dúvida entre dois tamanhos, fale com a maison.
      </p>
    </div>
  );
}
