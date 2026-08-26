import type { Metadata } from "next";
import {
  ALL_PAYMENT_METHODS,
  MP_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
} from "@/core/orders/payment-methods";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  getDefaultPolicy,
  getFeeRules,
  getSettingsMap,
  type DefaultPolicy,
  type FeeRule,
} from "@/services/settings";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { Table, Td, Tr } from "@/components/ui/table";
import { getSiteUrl } from "@/services/store-payments";
import {
  ApprovalRulesForm,
  FeeRuleForm,
  MercadoPagoForm,
  PolicyForm,
  StockSettingsForm,
  StoreDataForm,
} from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Configurações",
};

/** Método processado pelo MP? Os demais (Pix manual, dinheiro) o dono liquida. */
function isMpMethod(method: string): boolean {
  return (MP_PAYMENT_METHODS as readonly string[]).includes(method);
}

const whenFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatRatePercent(rate: number): string {
  return `${(rate * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

type SettingsData = {
  feeRules: { current: FeeRule[]; history: FeeRule[] };
  policy: DefaultPolicy | null;
  settings: {
    changeThresholdRate: number;
    firstPriceRequiresApproval: boolean;
    lowStockThreshold: number;
    reservationTtlMinutes: number;
  };
  store: {
    name: string;
    cnpj: string;
    address: string;
    email: string;
    whatsapp: string;
    pixKey: string;
  };
  mpEnabled: boolean;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function loadSettings(): Promise<SettingsData | null> {
  try {
    const db = getDb();
    const [feeRules, policy, map] = await Promise.all([
      getFeeRules(db),
      getDefaultPolicy(db),
      getSettingsMap(db, [
        "price_change_pct_threshold",
        "first_price_requires_approval",
        "default_low_stock_threshold",
        "stock_reservation_ttl_minutes",
        "store_name",
        "store_cnpj",
        "store_address",
        "store_email",
        "store_whatsapp",
        "store_pix_key",
        "mp_enabled",
      ]),
    ]);
    return {
      feeRules,
      policy,
      mpEnabled: map.mp_enabled === true,
      store: {
        name: asString(map.store_name),
        cnpj: asString(map.store_cnpj),
        address: asString(map.store_address),
        email: asString(map.store_email),
        whatsapp: asString(map.store_whatsapp),
        pixKey: asString(map.store_pix_key),
      },
      settings: {
        changeThresholdRate:
          map.price_change_pct_threshold === undefined
            ? 0.1
            : Number(map.price_change_pct_threshold),
        firstPriceRequiresApproval:
          map.first_price_requires_approval === undefined
            ? true
            : map.first_price_requires_approval === true,
        lowStockThreshold:
          map.default_low_stock_threshold === undefined
            ? 3
            : Number(map.default_low_stock_threshold),
        reservationTtlMinutes:
          map.stock_reservation_ttl_minutes === undefined
            ? 120
            : Number(map.stock_reservation_ttl_minutes),
      },
    };
  } catch {
    return null;
  }
}

export default async function ConfiguracoesPage() {
  await requireOwner("configuracoes");
  const data = await loadSettings();

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Configurações"
          subtitle="Taxas, precificação, aprovações e estoque."
        />
        <EmptyState
          title="Não foi possível carregar as configurações"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  const currentByMethod = new Map(
    data.feeRules.current.map((rule) => [rule.paymentMethod, rule]),
  );

  // Presença das credenciais (✓/pendente) — NUNCA exibimos os valores.
  const hasAccessToken = Boolean(process.env.MP_ACCESS_TOKEN?.trim());
  const hasWebhookSecret = Boolean(process.env.MP_WEBHOOK_SECRET?.trim());
  const webhookUrl = `${getSiteUrl()}/api/webhooks/mercadopago`;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Configurações"
        subtitle="Dados da loja, taxas do Mercado Pago, política de preços, aprovações e estoque."
      />

      <Card title="Dados da loja">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Aparecem no rodapé e nas páginas legais da loja — exigidos pelo
              Decreto 7.962/2013 (Lei do E-commerce).
            </p>
            {data.store.cnpj === "" || data.store.address === "" ? (
              <Badge tone="warning">pendente — obrigatório para vender</Badge>
            ) : null}
          </div>
          <StoreDataForm
            defaults={{
              name: data.store.name,
              cnpj: data.store.cnpj,
              address: data.store.address,
              email: data.store.email,
              whatsapp: data.store.whatsapp,
              pixKey: data.store.pixKey,
            }}
          />
        </div>
      </Card>

      <Card title="Taxas por forma de pagamento">
        <div className="flex flex-col gap-5">
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Confira as taxas reais no painel do Mercado Pago — elas mudam por
            plano e prazo de repasse. Pix manual e dinheiro na entrega não
            passam pelo Mercado Pago: a taxa padrão deles é zero.
          </p>

          <Table
            headers={[
              "Método",
              "Taxa %",
              "Tarifa fixa",
              "Prazo de repasse",
              "Referência",
              "Vigente desde",
            ]}
          >
            {ALL_PAYMENT_METHODS.map((method) => {
              const rule = currentByMethod.get(method);
              return (
                <Tr key={method}>
                  <Td className="font-medium">
                    {PAYMENT_METHOD_LABELS[method]}
                    {isMpMethod(method) ? null : (
                      <Badge tone="neutral" className="ml-2">
                        liquidação manual
                      </Badge>
                    )}
                  </Td>
                  {rule ? (
                    <>
                      <Td>{formatRatePercent(rule.percentRate)}</Td>
                      <Td>
                        <Money cents={rule.fixedFeeCents} />
                      </Td>
                      <Td>
                        {rule.settlementDays === 0
                          ? "Na hora"
                          : `${rule.settlementDays} dias`}
                      </Td>
                      <Td>
                        {rule.isReferenceForPricing ? (
                          <Badge tone="info">Referência</Badge>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">
                            —
                          </span>
                        )}
                      </Td>
                      <Td>{whenFormatter.format(rule.effectiveFrom)}</Td>
                    </>
                  ) : (
                    <Td colSpan={5} className="text-zinc-500 dark:text-zinc-400">
                      Sem taxa cadastrada — preencha a primeira vigência abaixo.
                    </Td>
                  )}
                </Tr>
              );
            })}
          </Table>

          <div className="flex flex-col gap-3">
            {ALL_PAYMENT_METHODS.map((method) => {
              const rule = currentByMethod.get(method);
              return (
                <details
                  key={method}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    Nova vigência — {PAYMENT_METHOD_LABELS[method]}
                  </summary>
                  <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                    <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
                      A taxa atual não é editada: ela entra para o histórico e a
                      nova passa a valer a partir de agora.
                    </p>
                    <FeeRuleForm
                      paymentMethod={method}
                      methodLabel={PAYMENT_METHOD_LABELS[method]}
                      defaults={
                        rule
                          ? {
                              percentRate: rule.percentRate,
                              fixedFeeCents: rule.fixedFeeCents,
                              settlementDays: rule.settlementDays,
                              installmentsMax: rule.installmentsMax,
                              isReferenceForPricing: rule.isReferenceForPricing,
                            }
                          : null
                      }
                    />
                  </div>
                </details>
              );
            })}
          </div>

          {data.feeRules.history.length > 0 ? (
            <details className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                Histórico de taxas ({data.feeRules.history.length})
              </summary>
              <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                <Table
                  headers={["Método", "Taxa %", "Tarifa fixa", "Valeu de", "Até"]}
                >
                  {data.feeRules.history.map((rule) => (
                    <Tr key={rule.id}>
                      <Td>{PAYMENT_METHOD_LABELS[rule.paymentMethod]}</Td>
                      <Td>{formatRatePercent(rule.percentRate)}</Td>
                      <Td>
                        <Money cents={rule.fixedFeeCents} />
                      </Td>
                      <Td>{whenFormatter.format(rule.effectiveFrom)}</Td>
                      <Td>
                        {rule.effectiveTo
                          ? whenFormatter.format(rule.effectiveTo)
                          : "—"}
                      </Td>
                    </Tr>
                  ))}
                </Table>
              </div>
            </details>
          ) : null}
        </div>
      </Card>

      <Card title="Mercado Pago">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Pagamento automático na loja: o cliente paga na hora com Pix ou
            cartão pelo Checkout Pro, e o pedido é confirmado sozinho quando o
            Mercado Pago avisa.
          </p>

          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-700 dark:text-zinc-300">
                Credencial de acesso (MP_ACCESS_TOKEN)
              </span>
              {hasAccessToken ? (
                <Badge tone="success">✓ configurada</Badge>
              ) : (
                <Badge tone="warning">pendente</Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-700 dark:text-zinc-300">
                Assinatura do webhook (MP_WEBHOOK_SECRET)
              </span>
              {hasWebhookSecret ? (
                <Badge tone="success">✓ configurada</Badge>
              ) : (
                <Badge tone="warning">pendente</Badge>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <p className="font-medium text-zinc-800 dark:text-zinc-200">
              Como configurar
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                Pegue as credenciais de produção no painel de desenvolvedores
                do Mercado Pago (mercadopago.com.br/developers → Suas
                integrações) e cadastre-as como variáveis de ambiente do site.
              </li>
              <li>
                No mesmo painel, em Webhooks, cadastre a URL{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                  {webhookUrl}
                </code>{" "}
                e marque os eventos de <strong>Pagamentos</strong>.
              </li>
              <li>Ligue o toggle abaixo e salve.</li>
            </ol>
          </div>

          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Sem credenciais, a loja segue no modo manual (WhatsApp/Pix) — nada
            quebra: o toggle só passa a valer quando as credenciais existirem.
          </p>

          <MercadoPagoForm defaults={{ mpEnabled: data.mpEnabled }} />
        </div>
      </Card>

      <Card title="Política de precificação">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Estes valores alimentam a calculadora de preços de todos os
            produtos.
          </p>
          <PolicyForm
            defaults={
              data.policy
                ? {
                    targetMarginRate: data.policy.targetMarginRate,
                    minMarginRate: data.policy.minMarginRate,
                    roundingMode: data.policy.roundingMode,
                    roundingDirection: data.policy.roundingDirection,
                    otherCostsFixedCents: data.policy.otherCostsFixedCents,
                  }
                : null
            }
          />
        </div>
      </Card>

      <Card title="Regras de aprovação">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Definem quando uma mudança de preço precisa passar por você antes
            de valer na loja.
          </p>
          <ApprovalRulesForm
            defaults={{
              changeThresholdRate: data.settings.changeThresholdRate,
              firstPriceRequiresApproval:
                data.settings.firstPriceRequiresApproval,
            }}
          />
        </div>
      </Card>

      <Card title="Estoque">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Regras gerais de alerta e reserva de estoque.
          </p>
          <StockSettingsForm
            defaults={{
              lowStockThreshold: data.settings.lowStockThreshold,
              reservationTtlMinutes: data.settings.reservationTtlMinutes,
            }}
          />
        </div>
      </Card>
    </div>
  );
}
