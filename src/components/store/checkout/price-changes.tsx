// Tabela "alguns preços mudaram" do checkout: item, antes, agora. Sem hooks.
import { formatCentsBRL } from "@/lib/money";
import type { PriceChange } from "@/services/store-orders";

export function PriceChangesTable({ changes }: { changes: PriceChange[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-store text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-500">
            <th scope="col" className="py-1 pr-2 font-medium">
              Peça
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Antes
            </th>
            <th scope="col" className="py-1 font-medium">
              Agora
            </th>
          </tr>
        </thead>
        <tbody className="text-ink-900">
          {changes.map((change) => (
            <tr key={change.variantId}>
              <td className="py-1 pr-2">{change.name}</td>
              <td className="py-1 pr-2 tabular-nums line-through opacity-60">
                {formatCentsBRL(change.oldPriceCents)}
              </td>
              <td className="py-1 font-semibold tabular-nums">
                {formatCentsBRL(change.newPriceCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
