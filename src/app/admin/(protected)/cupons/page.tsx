import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { categories, products } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import { listCoupons, type Coupon, type CouponListItem } from "@/services/coupons";
import { scheduleLabel } from "@/core/coupons/messages";
import { minutesToTime } from "@/lib/coupon-fields";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { Table, Td, Tr } from "@/components/ui/table";
import { Button } from "@/components/ui/form";
import { toggleCouponAction } from "./actions";
import { CouponCreateForm, CouponDeleteForm, CouponEditForm, type CouponCategoryOption, type CouponFormDefaults } from "./forms";
import { formatCouponValue, ORIGIN_LABELS } from "./labels";

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

/** As regras do cupom em etiquetas curtas: "1 por cliente", "1ª compra", "pessoal", "dom·sáb 14h–15h", "3 peças". */
function ruleChips(coupon: Coupon): string[] {
  const chips: string[] = [];
  if (coupon.perCustomerLimit !== null) chips.push(coupon.perCustomerLimit === 1 ? "1 por cliente" : `${coupon.perCustomerLimit} por cliente`);
  if (coupon.firstPurchaseOnly) chips.push("1ª compra");
  if (coupon.customerId !== null || coupon.phoneE164 !== null) chips.push(`pessoal · ${coupon.phoneE164 ?? "cadastro"}`);
  const schedule = scheduleLabel(coupon);
  if (schedule) chips.push(schedule);
  if (coupon.productIds.length > 0) chips.push(coupon.productIds.length === 1 ? "1 peça" : `${coupon.productIds.length} peças`);
  if (coupon.categoryIds.length > 0) chips.push(coupon.categoryIds.length === 1 ? "1 categoria" : `${coupon.categoryIds.length} categorias`);
  return chips;
}

/** Date -> valor de input datetime-local (round-trip com new Date() no server). */
function toDatetimeLocalValue(date: Date | null): string {
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toFormDefaults(coupon: Coupon, productRefs: string[]): CouponFormDefaults {
  return {
    type: coupon.type,
    value: coupon.type === "percent" ? String(coupon.value) : coupon.type === "fixed" ? (coupon.value / 100).toFixed(2).replace(".", ",") : "",
    minOrder: coupon.minOrderCents > 0 ? (coupon.minOrderCents / 100).toFixed(2).replace(".", ",") : "",
    startsAt: toDatetimeLocalValue(coupon.startsAt),
    expiresAt: toDatetimeLocalValue(coupon.expiresAt),
    maxUses: coupon.maxUses !== null ? String(coupon.maxUses) : "",
    perCustomerLimit: coupon.perCustomerLimit !== null ? String(coupon.perCustomerLimit) : "",
    customerPhone: coupon.phoneE164 ?? "",
    firstPurchaseOnly: coupon.firstPurchaseOnly,
    freeShippingScope: coupon.freeShippingScope,
    weekdays: coupon.validWeekdays ?? [],
    validFrom: coupon.validFromMinute !== null ? minutesToTime(coupon.validFromMinute) : "",
    validTo: coupon.validToMinute !== null ? minutesToTime(coupon.validToMinute) : "",
    productRefs: productRefs.join("\n"),
    categoryIds: coupon.categoryIds,
    note: coupon.note ?? "",
  };
}

async function loadPage(): Promise<{
  coupons: CouponListItem[];
  categories: CouponCategoryOption[];
  slugById: Map<string, string>;
} | null> {
  try {
    const db = getDb();
    const coupons = await listCoupons(db);
    const categoryRows = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .orderBy(asc(categories.name));
    const productIds = [...new Set(coupons.flatMap((coupon) => coupon.productIds))];
    const slugRows =
      productIds.length > 0
        ? await db
            .select({ id: products.id, slug: products.slug })
            .from(products)
            .where(and(inArray(products.id, productIds), isNull(products.deletedAt)))
        : [];
    return { coupons, categories: categoryRows, slugById: new Map(slugRows.map((row) => [row.id, row.slug])) };
  } catch {
    return null;
  }
}

export default async function CuponsPage() {
  await requireOwner("cupons");
  const page = await loadPage();

  if (!page) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Cupons"
          subtitle="Códigos de desconto que a cliente aplica na sacola."
        />
        <EmptyState
          title="Não foi possível carregar os cupons"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }
  const { coupons, categories: categoryOptions, slugById } = page;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Cupons"
        subtitle="Códigos de desconto que a cliente aplica na sacola — ou recebe pelo link /c/CÓDIGO."
      />

      <Card title="Cupons cadastrados">
        <div className="flex flex-col gap-5">
          <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">
            Divulgue o código no WhatsApp ou o link <span className="font-mono">trivemaison.com.br/c/CÓDIGO</span> no story —
            quem toca já chega com o cupom aplicado na sacola.
          </p>

          {coupons.length === 0 ? (
            <EmptyState
              title="Nenhum cupom cadastrado"
              hint="Crie o primeiro cupom abaixo e compartilhe o código com suas clientes."
            />
          ) : (
            <Table
              headers={[
                "Código",
                "Desconto",
                "Regras",
                "Vigência",
                "Usos",
                "Status",
                "Ações",
              ]}
            >
              {coupons.map((coupon) => {
                const chips = ruleChips(coupon);
                return (
                  <Tr
                    key={coupon.id}
                    className={coupon.isActive ? undefined : "opacity-60"}
                  >
                    <Td>
                      <div className="flex flex-col gap-1">
                        <span className="font-mono font-medium">{coupon.code}</span>
                        {coupon.origin !== "manual" ? (
                          <Badge tone="info">{ORIGIN_LABELS[coupon.origin]}</Badge>
                        ) : null}
                        {coupon.note ? (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">{coupon.note}</span>
                        ) : null}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <div className="flex flex-col gap-0.5">
                        <span>{formatCouponValue(coupon)}</span>
                        {coupon.minOrderCents > 0 ? (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            mínimo <Money cents={coupon.minOrderCents} />
                          </span>
                        ) : null}
                      </div>
                    </Td>
                    <Td>
                      {chips.length === 0 ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {chips.map((chip) => (
                            <Badge key={chip} tone="neutral">
                              {chip}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">{formatValidity(coupon)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      <Link href={`/admin/cupons/${coupon.id}`} className="underline underline-offset-2 hover:text-indigo-600">
                        {formatUses(coupon)}
                      </Link>
                    </Td>
                    <Td>
                      {coupon.isActive ? (
                        <Badge tone="success">Ativo</Badge>
                      ) : (
                        <Badge tone="neutral">Inativo</Badge>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-start gap-2">
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
                        <Link
                          href={`/admin/cupons/${coupon.id}`}
                          className="inline-flex items-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Quem usou ({coupon.redemptionsCount})
                        </Link>
                        {coupon.usedCount === 0 && !coupon.everRedeemed ? (
                          <CouponDeleteForm couponId={coupon.id} code={coupon.code} />
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </Table>
          )}

          {coupons.length > 0 ? (
            <div className="flex flex-col gap-3">
              {coupons.map((coupon) => {
                const locked = coupon.usedCount > 0 || coupon.everRedeemed;
                return (
                  <details
                    key={coupon.id}
                    className="rounded-lg border border-zinc-200 dark:border-zinc-800"
                  >
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      Editar — {coupon.code}
                    </summary>
                    <div className="flex flex-col gap-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
                      {locked ? (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          Este cupom já foi usado: o tipo, o valor e as regras não mudam mais
                          (pedidos já feitos dependem deles). Para outro desconto, crie um cupom
                          novo e desative este.
                        </p>
                      ) : null}
                      <CouponEditForm
                        couponId={coupon.id}
                        locked={locked}
                        categories={categoryOptions}
                        defaults={toFormDefaults(
                          coupon,
                          // Peça apagada do catálogo sai do form (o serviço não a acharia ao salvar).
                          coupon.productIds.flatMap((id) => slugById.get(id) ?? []),
                        )}
                      />
                    </div>
                  </details>
                );
              })}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Novo cupom">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Escolha um código fácil de digitar e o tipo de desconto. Pedido mínimo,
            validade, limite de usos e as regras (por cliente, peças, dia e horário)
            são opcionais.
          </p>
          <CouponCreateForm categories={categoryOptions} />
        </div>
      </Card>
    </div>
  );
}
