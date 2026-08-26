import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { paymentFeeRules } from "@/db/schema";
import { isOwner } from "@/services/auth";
import type { getOrderDetail } from "@/services/orders";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";

type OrderDetail = NonNullable<Awaited<ReturnType<typeof getOrderDetail>>>;

/** Cor do delta margem real − prevista: verde quando ≥ 0, vermelho abaixo. */
function deltaClass(deltaCents: number): string {
  return deltaCents >= 0
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-red-700 dark:text-red-400";
}

function formatDeltaCents(deltaCents: number): string {
  const abs = (Math.abs(deltaCents) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  return `${deltaCents >= 0 ? "+" : "−"}${abs}`;
}

/**
 * Margem do pedido — só o proprietário. O guard é a primeira linha de
 * propósito: as consultas de taxa e a conta com o custo dos itens nem chegam
 * a rodar para a equipe, então nenhum valor de margem entra no HTML.
 */
export async function OrderMarginCard({ order }: { order: OrderDetail }) {
  if (!(await isOwner())) return null;

  const db = getDb();

  // Taxa estimada (regra vigente) × taxa real (mp_fee_cents). Leitura direta,
  // sem mutação. A regra vigente do MÉTODO do pedido é a estimativa; sem
  // método definido, usa a regra de referência de preços.
  const [methodRule] = order.paymentMethod
    ? await db
        .select()
        .from(paymentFeeRules)
        .where(
          and(
            eq(paymentFeeRules.paymentMethod, order.paymentMethod),
            isNull(paymentFeeRules.effectiveTo),
          ),
        )
        .limit(1)
    : [undefined];
  const [referenceRule] = methodRule
    ? [methodRule]
    : await db
        .select()
        .from(paymentFeeRules)
        .where(
          and(
            eq(paymentFeeRules.isReferenceForPricing, true),
            isNull(paymentFeeRules.effectiveTo),
          ),
        )
        .limit(1);
  const feeRule = methodRule ?? referenceRule;

  // Margem dos itens = Σ (preço − custo) × qtd (frete é repasse, fica fora).
  const itemsMarginCents = order.items.reduce(
    (total, item) =>
      total + (item.unitPriceCents - item.unitCostCents) * item.quantity,
    0,
  );
  const estimatedFeeCents = feeRule
    ? Math.round(order.totalCents * Number(feeRule.percentRate)) +
      feeRule.fixedFeeCents
    : null;
  const expectedMarginCents =
    estimatedFeeCents !== null ? itemsMarginCents - estimatedFeeCents : null;
  const realMarginCents =
    order.mpFeeCents !== null ? itemsMarginCents - order.mpFeeCents : null;
  const marginDeltaCents =
    expectedMarginCents !== null && realMarginCents !== null
      ? realMarginCents - expectedMarginCents
      : null;

  return (
    <Card title="Margem do pedido — prevista × real">
      <dl className="flex flex-col gap-1.5 text-sm">
        <div className="flex justify-between gap-8">
          <dt className="text-zinc-500 dark:text-zinc-400">
            Itens (preço − custo)
          </dt>
          <dd className="text-zinc-900 dark:text-zinc-100">
            <Money cents={itemsMarginCents} />
          </dd>
        </div>
        <div className="flex justify-between gap-8">
          <dt className="text-zinc-500 dark:text-zinc-400">
            Taxa estimada (regra vigente)
          </dt>
          <dd className="text-zinc-900 dark:text-zinc-100">
            {estimatedFeeCents !== null ? (
              <>
                − <Money cents={estimatedFeeCents} />
              </>
            ) : (
              "sem regra vigente"
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-8 border-t border-zinc-200 pt-1.5 dark:border-zinc-800">
          <dt className="font-medium text-zinc-700 dark:text-zinc-300">
            Margem prevista
          </dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-100">
            {expectedMarginCents !== null ? (
              <Money cents={expectedMarginCents} />
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-8">
          <dt className="font-medium text-zinc-700 dark:text-zinc-300">
            Margem real (taxa do MP)
          </dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-100">
            {realMarginCents !== null ? (
              <Money cents={realMarginCents} />
            ) : (
              "aguardando pagamento"
            )}
          </dd>
        </div>
        {marginDeltaCents !== null ? (
          <div className="flex justify-between gap-8">
            <dt className="text-zinc-500 dark:text-zinc-400">
              Diferença (real − prevista)
            </dt>
            <dd className={`font-semibold ${deltaClass(marginDeltaCents)}`}>
              {formatDeltaCents(marginDeltaCents)}
            </dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}
