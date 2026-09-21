// Quem é a cliente, pelo que o checkout e a Lia conhecem (CPF, telefone), e
// quantas compras de verdade ela já fez. Só leitura — o upsert do cadastro
// continua em createStoreOrder.
import { and, eq, inArray, isNull } from "drizzle-orm";

import { COUNTED_STATUSES, countsAsPurchase } from "@/core/edition/debut";
import { customers, orders } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

export interface KnownCustomer {
  id: string;
  fullName: string;
  phoneE164: string | null;
  marketingOptIn: boolean;
}

/** Cadastro pelo CPF/CNPJ (só dígitos) primeiro, senão pelo telefone E.164. */
export async function findCustomerByDocumentOrPhone(
  db: DbOrTx,
  input: { documentDigits?: string | null; phoneE164?: string | null },
): Promise<KnownCustomer | null> {
  const fields = {
    id: customers.id,
    fullName: customers.fullName,
    phoneE164: customers.phoneE164,
    marketingOptIn: customers.marketingOptIn,
  };
  if (input.documentDigits) {
    const [byDocument] = await db
      .select(fields)
      .from(customers)
      .where(and(eq(customers.documentNumber, input.documentDigits), isNull(customers.deletedAt)));
    if (byDocument) return byDocument;
  }
  if (input.phoneE164) {
    const [byPhone] = await db
      .select(fields)
      .from(customers)
      .where(and(eq(customers.phoneE164, input.phoneE164), isNull(customers.deletedAt)));
    if (byPhone) return byPhone;
  }
  return null;
}

/** Compras de verdade (paga em diante; reembolsada só se a caixa saiu) — a régua da estreia. */
export async function countCustomerPurchases(db: DbOrTx, customerId: string): Promise<number> {
  const rows = await db
    .select({ status: orders.status, shippedAt: orders.shippedAt })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, [...COUNTED_STATUSES])));
  return rows.filter(countsAsPurchase).length;
}
