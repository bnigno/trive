import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listShippingRates, type ShippingRate } from "@/services/shipping";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { Table, Td, Tr } from "@/components/ui/table";
import { Button } from "@/components/ui/form";
import { toggleShippingRateAction } from "./actions";
import {
  ShippingRateCreateForm,
  ShippingRateEditForm,
  type RateFormDefaults,
} from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Frete",
};

/** '01310100' -> '01310-100'. */
function formatCep(digits: string): string {
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function formatKg(grams: number): string {
  return `${(grams / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} kg`;
}

function formatDeliveryDays(min: number, max: number): string {
  if (min === max) return min === 1 ? "1 dia" : `${min} dias`;
  return `${min} a ${max} dias`;
}

/** 2490 -> '24,90' (para preencher o input de preço). */
function centsToInput(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toFormDefaults(rate: ShippingRate): RateFormDefaults {
  return {
    name: rate.name,
    cepStart: formatCep(rate.cepStart),
    cepEnd: formatCep(rate.cepEnd),
    weightMinKg: (rate.weightMinGrams / 1000).toLocaleString("pt-BR", {
      maximumFractionDigits: 3,
    }),
    weightMaxKg: (rate.weightMaxGrams / 1000).toLocaleString("pt-BR", {
      maximumFractionDigits: 3,
    }),
    price: centsToInput(rate.priceCents),
    deliveryDaysMin: rate.deliveryDaysMin,
    deliveryDaysMax: rate.deliveryDaysMax,
  };
}

async function loadRates(): Promise<ShippingRate[] | null> {
  try {
    return await listShippingRates(getDb());
  } catch {
    return null;
  }
}

export default async function FretePage() {
  await requireUser();
  const rates = await loadRates();

  if (!rates) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Frete"
          subtitle="Faixas de CEP e peso com preço e prazo de entrega."
        />
        <EmptyState
          title="Não foi possível carregar as faixas de frete"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Frete"
        subtitle="Faixas de CEP e peso com preço e prazo de entrega."
      />

      <Card title="Faixas de frete">
        <div className="flex flex-col gap-5">
          <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">
            O cliente vê a opção mais barata que cobre o CEP e o peso do
            pedido. A faixa padrão cobre o Brasil inteiro — crie faixas
            específicas (ex.: capital) com preço menor e elas vencem por serem
            mais baratas.
          </p>

          {rates.length === 0 ? (
            <EmptyState
              title="Nenhuma faixa de frete cadastrada"
              hint="Sem faixa ativa a loja não consegue cotar frete. Crie a primeira abaixo."
            />
          ) : (
            <Table
              headers={[
                "Nome",
                "Faixa de CEP",
                "Faixa de peso",
                "Preço",
                "Prazo",
                "Status",
                "Ações",
              ]}
            >
              {rates.map((rate) => (
                <Tr key={rate.id} className={rate.isActive ? undefined : "opacity-60"}>
                  <Td className="font-medium">{rate.name}</Td>
                  <Td className="whitespace-nowrap">
                    {formatCep(rate.cepStart)} – {formatCep(rate.cepEnd)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatKg(rate.weightMinGrams)} – {formatKg(rate.weightMaxGrams)}
                  </Td>
                  <Td>
                    <Money cents={rate.priceCents} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatDeliveryDays(rate.deliveryDaysMin, rate.deliveryDaysMax)}
                  </Td>
                  <Td>
                    {rate.isActive ? (
                      <Badge tone="success">Ativa</Badge>
                    ) : (
                      <Badge tone="neutral">Inativa</Badge>
                    )}
                  </Td>
                  <Td>
                    <form action={toggleShippingRateAction}>
                      <input type="hidden" name="id" value={rate.id} />
                      <Button type="submit" variant="outline" size="sm">
                        {rate.isActive ? "Desativar" : "Ativar"}
                      </Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </Table>
          )}

          {rates.length > 0 ? (
            <div className="flex flex-col gap-3">
              {rates.map((rate) => (
                <details
                  key={rate.id}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    Editar — {rate.name}
                  </summary>
                  <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                    <ShippingRateEditForm
                      rateId={rate.id}
                      isActive={rate.isActive}
                      defaults={toFormDefaults(rate)}
                    />
                  </div>
                </details>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Nova faixa de frete">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Informe a faixa de CEP e de peso que ela cobre, o preço e o prazo
            de entrega em dias.
          </p>
          <ShippingRateCreateForm />
        </div>
      </Card>
    </div>
  );
}
