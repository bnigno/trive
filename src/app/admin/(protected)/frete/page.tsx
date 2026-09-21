import type { Metadata } from "next";
import { getAdapterMode } from "@/adapters/adapter-mode";
import { isCorreiosQuotesConfigured } from "@/adapters/superfrete";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { hourLabel } from "@/core/shipping/delivery-windows";
import { getCorreiosAutoSettings, type CorreiosAutoSettings } from "@/services/correios-quotes";
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
  CorreiosAutoForm,
  CorreiosProbeForm,
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
    kind: rate.kind,
    deliveryWindows: rate.deliveryWindows,
  };
}

/** "9h–12h (até 8h) · 19h–21h (até 13h)" para a tabela. */
function formatWindows(rate: ShippingRate): string {
  return rate.deliveryWindows.map((w) => `${hourLabel(w.start)}–${hourLabel(w.end)} (até ${hourLabel(w.cutoff)})`).join(" · ");
}

async function loadRates(): Promise<{ rates: ShippingRate[]; correios: CorreiosAutoSettings } | null> {
  try {
    const db = getDb();
    const rates = await listShippingRates(db);
    const correios = await getCorreiosAutoSettings(db);
    return { rates, correios };
  } catch {
    return null;
  }
}

export default async function FretePage() {
  await requireOwner("frete");
  const loaded = await loadRates();

  if (!loaded) {
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

  const { rates, correios } = loaded;
  const correiosTokenReady = isCorreiosQuotesConfigured();
  const correiosSimulated = correiosTokenReady && getAdapterMode() !== "real";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Frete"
        subtitle="Faixas de CEP e peso com preço e prazo de entrega."
      />

      <Card title="Faixas de frete">
        <div className="flex flex-col gap-5">
          <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">
            Onde uma faixa de <strong>motoboy</strong> cobre o CEP, a cliente vê
            SÓ o motoboy (uma opção por janela, a de hoje primeiro) — as faixas
            de Correios ficam para os CEPs sem motoboy. Sem nenhuma faixa para o
            CEP, o site e a Lia dizem que a entrega é pelos Correios com o frete
            calculado pela equipe: a cliente chega no WhatsApp com a sacola e o
            CEP, e a equipe cota no site dos Correios e fecha por lá. Com o{" "}
            <strong>Correios automático</strong> ligado (cartão abaixo), esses
            CEPs sem faixa recebem PAC e SEDEX cotados na hora pela SuperFrete,
            já com o acréscimo de embalagem; se a cotação falhar, vale o fluxo
            pela equipe. O nome da faixa de motoboy é o que a cliente lê
            (&ldquo;Motoboy Belém&rdquo;) e monta a lista de cidades atendidas.
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
                    {rate.kind === "motoboy" ? (
                      <span>
                        <span className="font-medium">Motoboy</span>
                        <span className="block text-xs text-zinc-500">{formatWindows(rate)}</span>
                      </span>
                    ) : (
                      formatDeliveryDays(rate.deliveryDaysMin, rate.deliveryDaysMax)
                    )}
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

      <Card title="Correios automático (SuperFrete)">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Fora da área do motoboy, a loja e a Lia cotam PAC e SEDEX na hora
            pela SuperFrete (preços já com o desconto da plataforma) e somam o
            acréscimo de embalagem. As suas faixas continuam valendo na frente:
            a cotação automática só entra quando nenhuma faixa ativa atende o
            CEP <em>e o peso</em> da sacola — e nenhuma faixa de motoboy ativa
            cobre o CEP. Atenção: <strong>desativar</strong> uma faixa de motoboy
            faz os CEPs dela passarem a receber PAC e SEDEX (antes, ficavam com o
            frete pela equipe). A postagem segue manual — você gera a etiqueta
            no painel da SuperFrete e marca o pedido como enviado.
          </p>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300">
              Token da SuperFrete (SUPERFRETE_TOKEN)
            </span>
            {correiosSimulated ? (
              <Badge tone="success">✓ simulado (ADAPTER_MODE=fake)</Badge>
            ) : correiosTokenReady ? (
              <Badge tone="success">✓ configurado</Badge>
            ) : (
              <Badge tone="warning">pendente</Badge>
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <p className="font-medium text-zinc-800 dark:text-zinc-200">Como configurar</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                Crie a conta em superfrete.com (CPF ou CNPJ, sem mensalidade) e, em{" "}
                <strong>Integrações</strong>, gere o token da API.
              </li>
              <li>
                Cadastre{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                  SUPERFRETE_TOKEN
                </code>{" "}
                nas variáveis de ambiente do site (Vercel → Production). Só você tem acesso a esse painel.
              </li>
              <li>
                Informe o CEP de origem (um CEP real — a SuperFrete recusa o genérico da cidade), confira o
                acréscimo e salve; use <strong>Testar cotação</strong> e só então ligue o toggle.
              </li>
            </ol>
          </div>

          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Sem o token ou sem o CEP de origem, nada muda: os CEPs sem faixa
            seguem com o frete calculado pela equipe. Para voltar ao fluxo
            antigo a qualquer momento, basta desligar o toggle.
          </p>

          <CorreiosAutoForm
            defaults={{
              enabled: correios.enabled,
              storeCep: correios.storeCep ? formatCep(correios.storeCep) : "",
              surcharge: centsToInput(correios.surchargeCents),
            }}
          />

          <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 px-4 py-4 dark:border-zinc-800">
            <div>
              <p className="font-medium text-zinc-800 dark:text-zinc-200">Testar cotação</p>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Chama a SuperFrete de verdade com o CEP de origem salvo acima, mesmo
                com o toggle desligado — não grava nada. Se falhar, a mensagem diz o
                que falta (token, CEP de origem, SuperFrete fora do ar).
              </p>
            </div>
            <CorreiosProbeForm simulated={correiosSimulated} />
          </div>
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
