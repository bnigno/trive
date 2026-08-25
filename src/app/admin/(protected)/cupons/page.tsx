import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listCoupons, type Coupon } from "@/services/coupons";
import { formatCentsBRL } from "@/lib/money";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { Table, Td, Tr } from "@/components/ui/table";
import { Button } from "@/components/ui/form";
import { toggleCouponAction } from "./actions";
import { CouponCreateForm, CouponEditForm } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cupons",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** '10%' para percentual; 'R$ 10,00' para valor fixo. */
function formatValue(coupon: Coupon): string {
  return coupon.type === "percent"
    ? `${coupon.value}%`
    : formatCentsBRL(coupon.value);
}

/** Período de vigência legível: 'Sempre', 'até …', 'a partir de …' ou 'X – Y'. */
function formatValidity(coupon: Coupon): string {
  const start = coupon.startsAt ? dateTimeFormatter.format(coupon.startsAt) : null;
  const end = coupon.expiresAt ? dateTimeFormatter.format(coupon.expiresAt) : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `a partir de ${start}`;
  if (end) return `até ${end}`;
  return "Sempre";
}

/** 'X de Y' quando há limite; só 'X' quando ilimitado. */
function formatUses(coupon: Coupon): string {
  return coupon.maxUses !== null
    ? `${coupon.usedCount} de ${coupon.maxUses}`
    : String(coupon.usedCount);
}

/** Date -> valor de input datetime-local (round-trip com new Date() no server). */
function toDatetimeLocalValue(date: Date | null): string {
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadCoupons(): Promise<Coupon[] | null> {
  try {
    return await listCoupons(getDb());
  } catch {
    return null;
  }
}

export default async function CuponsPage() {
  await requireUser();
  const coupons = await loadCoupons();

  if (!coupons) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Cupons"
          subtitle="Códigos de desconto que o cliente aplica na sacola."
        />
        <EmptyState
          title="Não foi possível carregar os cupons"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Cupons"
        subtitle="Códigos de desconto que o cliente aplica na sacola."
      />

      <Card title="Cupons cadastrados">
        <div className="flex flex-col gap-5">
          <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">
            Divulgue o código no WhatsApp ou redes — o desconto aparece no
            carrinho.
          </p>

          {coupons.length === 0 ? (
            <EmptyState
              title="Nenhum cupom cadastrado"
              hint="Crie o primeiro cupom abaixo e compartilhe o código com seus clientes."
            />
          ) : (
            <Table
              headers={[
                "Código",
                "Desconto",
                "Pedido mínimo",
                "Vigência",
                "Usos",
                "Status",
                "Ações",
              ]}
            >
              {coupons.map((coupon) => (
                <Tr
                  key={coupon.id}
                  className={coupon.isActive ? undefined : "opacity-60"}
                >
                  <Td className="font-mono font-medium">{coupon.code}</Td>
                  <Td className="whitespace-nowrap">{formatValue(coupon)}</Td>
                  <Td>
                    {coupon.minOrderCents > 0 ? (
                      <Money cents={coupon.minOrderCents} />
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{formatValidity(coupon)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {formatUses(coupon)}
                  </Td>
                  <Td>
                    {coupon.isActive ? (
                      <Badge tone="success">Ativo</Badge>
                    ) : (
                      <Badge tone="neutral">Inativo</Badge>
                    )}
                  </Td>
                  <Td>
                    <form action={toggleCouponAction}>
                      <input type="hidden" name="id" value={coupon.id} />
                      <input
                        type="hidden"
                        name="nextActive"
                        value={coupon.isActive ? "false" : "true"}
                      />
                      <Button type="submit" variant="outline" size="sm">
                        {coupon.isActive ? "Desativar" : "Ativar"}
                      </Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </Table>
          )}

          {coupons.length > 0 ? (
            <div className="flex flex-col gap-3">
              {coupons.map((coupon) => (
                <details
                  key={coupon.id}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    Editar — {coupon.code}
                  </summary>
                  <div className="flex flex-col gap-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      O tipo e o valor do desconto não mudam depois de criado
                      (pedidos já feitos dependem deles). Para outro desconto,
                      crie um cupom novo e desative este.
                    </p>
                    <CouponEditForm
                      couponId={coupon.id}
                      defaults={{
                        expiresAt: toDatetimeLocalValue(coupon.expiresAt),
                        maxUses:
                          coupon.maxUses !== null ? String(coupon.maxUses) : "",
                      }}
                    />
                  </div>
                </details>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Novo cupom">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Escolha um código fácil de digitar, o tipo de desconto e, se quiser,
            um pedido mínimo, o período de validade e um limite de usos.
          </p>
          <CouponCreateForm />
        </div>
      </Card>
    </div>
  );
}
