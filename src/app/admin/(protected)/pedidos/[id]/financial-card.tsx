import Link from "next/link";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { financialEntries } from "@/db/schema";
import { isOwner } from "@/services/auth";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Table, Td, Tr } from "@/components/ui/table";
import { formatDateTimeSP } from "../format";

const ENTRY_DIRECTION_LABELS: Record<string, string> = {
  receivable: "A receber",
  payable: "A pagar",
};

const ENTRY_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  settled: "Liquidado",
  canceled: "Cancelado",
};

/**
 * Lançamentos financeiros do pedido — só o proprietário. O guard é a primeira
 * linha de propósito: a consulta nem roda para a equipe, e o link para
 * /admin/financeiro (área do dono) some junto com o card.
 */
export async function OrderFinancialCard({ orderId }: { orderId: string }) {
  if (!(await isOwner())) return null;

  // Leitura simples (sem mutação): lançamentos financeiros ligados ao pedido.
  const entries = await getDb()
    .select()
    .from(financialEntries)
    .where(eq(financialEntries.orderId, orderId))
    .orderBy(financialEntries.createdAt);

  return (
    <Card title="Financeiro do pedido">
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Nenhum lançamento financeiro ainda. Ao marcar o pedido como pago, a
          venda é lançada automaticamente.
        </p>
      ) : (
        <Table headers={["Descrição", "Tipo", "Valor", "Situação", "Data"]}>
          {entries.map((entry) => (
            <Tr key={entry.id}>
              <Td>{entry.description}</Td>
              <Td>
                {ENTRY_DIRECTION_LABELS[entry.direction] ?? entry.direction}
              </Td>
              <Td>
                <Money cents={entry.amountCents} className="font-medium" />
              </Td>
              <Td>{ENTRY_STATUS_LABELS[entry.status] ?? entry.status}</Td>
              <Td className="whitespace-nowrap">
                {formatDateTimeSP(entry.createdAt)}
              </Td>
            </Tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Veja tudo em{" "}
        <Link
          href="/admin/financeiro"
          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Financeiro
        </Link>
        .
      </p>
    </Card>
  );
}
