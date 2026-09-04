// Página pública de acompanhamento do pedido, por token — "seu pedido" no
// papel timbrado da maison. Sempre dinâmica: o status muda a qualquer momento
// (pagamento, envio, expiração da reserva) e getPublicOrder já expira
// reservas vencidas antes de responder.
// PRIVACIDADE: getPublicOrder NÃO retorna dados pessoais — e esta página não
// adiciona nenhum (o link circula em encaminhamentos de WhatsApp).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Monogram } from "@/components/store/brand/monogram";
import { IconParcel } from "@/components/store/icons";
import { NoirStage } from "@/components/store/noir-stage";
import { Notice } from "@/components/store/order/notice";
import { Sheet } from "@/components/store/order/sheet";
import { TotalsList } from "@/components/store/order/totals";
import { OrderStatusSteps } from "@/components/store/order-status-steps";
import { Ornament } from "@/components/store/ornament";
import {
  btnPrimary,
  eyebrow,
  linkGold,
  numeral,
  panelGold,
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { getDb } from "@/db/client";
import { formatCentsBRL } from "@/lib/money";
import { waMeUrl } from "@/lib/phone";
import { getPublicOrder } from "@/services/store-orders";
import { isMpEnabled } from "@/services/store-payments";
import { getSettingsMap } from "@/services/settings";

import { payNowAction } from "./actions";
import { CopyCode } from "./copy-code";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Acompanhar pedido",
  robots: { index: false, follow: false },
};

const dateFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDueAt(date: Date): string {
  return `${dateFmt.format(date)} às ${timeFmt.format(date)}`;
}

/** Link wa.me da setting store_whatsapp com a mensagem do pedido pré-preenchida. */
function waMeLink(rawPhone: unknown, orderNumber: number): string | null {
  return waMeUrl(
    rawPhone,
    `Olá! Fiz o pedido #${orderNumber} e quero combinar o pagamento`,
  );
}

/** "Reserva válida até …" quando o pedido tem prazo de pagamento. */
function DueAt({ date }: { date: Date | null }) {
  if (!date) return null;
  return (
    <>
      {" "}
      Reserva válida até{" "}
      <strong className="font-medium whitespace-nowrap text-ink-900">
        {formatDueAt(date)}
      </strong>
      .
    </>
  );
}

function WhatsAppLink({
  href,
  children,
}: {
  href: string | null;
  children: string;
}) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkGold}>
      {children}
    </a>
  );
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{
    novo?: string;
    /** back_urls do Mercado Pago: ?collection_status=approved&status=approved… */
    collection_status?: string;
    status?: string;
    /** ?pagamento=indisponivel — payNowAction não conseguiu iniciar o MP. */
    pagamento?: string;
  }>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const { novo } = query;

  const db = getDb();
  const order = await getPublicOrder(db, token);
  if (!order) notFound();

  const isPendingPayment = order.status === "pending_payment";
  const isCanceled = order.status === "canceled" || order.status === "refunded";
  const reservationExpired =
    order.status === "canceled" &&
    (order.canceledReason ?? "").includes("Reserva expirada");

  // Volta do Checkout Pro com aprovação: banner otimista — a confirmação REAL
  // vem do webhook (a página sempre mostra o status do banco, nunca da query).
  const mpApproved =
    isPendingPayment &&
    (query.collection_status === "approved" || query.status === "approved");
  const mpUnavailable = isPendingPayment && query.pagamento === "indisponivel";

  // Variante do bloco "Como pagar" pela forma de pagamento do pedido:
  // cash → dinheiro na entrega; pix_manual COM chave cadastrada → chave
  // copiável; pix_manual SEM chave e demais casos → MP (se habilitado) ou
  // combinação pelo WhatsApp.
  const isCash = order.paymentMethod === "cash";
  const isPixManual = order.paymentMethod === "pix_manual";

  const settings = isPendingPayment
    ? await getSettingsMap(db, ["store_whatsapp", "store_pix_key"])
    : {};
  const pixKey =
    typeof settings["store_pix_key"] === "string"
      ? settings["store_pix_key"].trim()
      : "";
  const showPixManual = isPendingPayment && isPixManual && pixKey !== "";
  const mpEnabled =
    isPendingPayment && !isCash && !isPixManual ? await isMpEnabled(db) : false;

  const whatsappLink = isPendingPayment
    ? waMeLink(settings["store_whatsapp"], order.orderNumber)
    : null;

  const total = formatCentsBRL(order.totalCents);
  const showTracking =
    (order.status === "shipped" || order.status === "delivered") &&
    Boolean(order.trackingCode);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      {/* O único momento noir da página: o agradecimento, sem nenhum input. */}
      {novo === "1" && !isCanceled ? (
        <NoirStage
          as="div"
          grain
          role="status"
          className="mb-10 rounded-(--radius-hair) px-6 py-10 text-center sm:py-14"
        >
          <Monogram tone="gold" size={56} className="mx-auto" />
          <p className="mt-5 font-display text-title font-semibold text-balance text-ivory-100 italic">
            A maison agradece. Recebemos o seu pedido.
          </p>
          <p className="mt-3 font-store text-sm text-ivory-300">
            Acompanhe tudo por esta página — e guarde o link.
          </p>
        </NoirStage>
      ) : null}

      <header className="mb-10 flex flex-col items-start gap-2">
        <p className={eyebrow}>Seu pedido</p>
        <h1 className="font-display font-semibold text-espresso-900">
          <span className="text-heading text-gold-800">Nº</span>{" "}
          <span className="text-display tabular-nums">{order.orderNumber}</span>
        </h1>
        <p className="font-display text-lg text-ink-700 italic">
          Feito em {formatDueAt(order.createdAt)}
        </p>
        <Ornament className="mt-2 text-gold-500" />
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-16">
        <div className="flex flex-col gap-8">
          {isCanceled ? (
            <Notice
              tone="claret"
              role="alert"
              title={
                order.status === "refunded"
                  ? "Este pedido foi reembolsado"
                  : "Este pedido foi cancelado"
              }
            >
              {reservationExpired ? (
                <p>
                  A reserva dos produtos expirou porque o pagamento não foi
                  confirmado dentro do prazo. Não se preocupe: nada foi cobrado,
                  e você pode refazer o pedido quando quiser — é rapidinho.
                </p>
              ) : order.canceledReason ? (
                <p>
                  Motivo: {order.canceledReason}. Se ficou alguma dúvida, fale
                  com a gente — teremos prazer em ajudar.
                </p>
              ) : (
                <p>
                  Se ficou alguma dúvida, fale com a gente — teremos prazer em
                  ajudar.
                </p>
              )}
              {reservationExpired ? (
                <Link href="/produtos" className={cx(btnPrimary, "mt-5")}>
                  Refazer meu pedido
                </Link>
              ) : null}
            </Notice>
          ) : (
            <Sheet
              eyebrow="Andamento"
              headingId="andamento-title"
              aria-labelledby="andamento-title"
            >
              <div className="mt-5">
                <OrderStatusSteps status={order.status} />
              </div>
            </Sheet>
          )}

          {mpApproved ? (
            <Notice tone="laurel" role="status" title="Pagamento recebido! Confirmando…">
              <p>
                O Mercado Pago aprovou o seu pagamento. Em instantes o pedido
                aparece como pago aqui — pode atualizar a página para conferir.
              </p>
            </Notice>
          ) : null}

          {isPendingPayment && !mpApproved ? (
            <section aria-labelledby="pagar-title" className={panelGold}>
              <h2 id="pagar-title" className={eyebrow}>
                Como pagar
              </h2>
              <p className="mt-2 font-display text-3xl font-semibold text-ink-900 tabular-nums">
                {total}
              </p>
              {isCash ? (
                <>
                  <p className="mt-3 font-store text-[15px] leading-7 text-ink-800">
                    Você paga em dinheiro ao receber — combinamos os detalhes
                    pelo WhatsApp. Tenha{" "}
                    <strong className="font-medium whitespace-nowrap text-ink-900">
                      {total}
                    </strong>{" "}
                    em mãos.
                  </p>
                  {whatsappLink ? (
                    <a
                      href={whatsappLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cx(btnPrimary, "mt-5")}
                    >
                      Chamar no WhatsApp
                    </a>
                  ) : null}
                </>
              ) : showPixManual ? (
                <>
                  <p className="mt-3 font-store text-[15px] leading-7 text-ink-800">
                    Faça um Pix de{" "}
                    <strong className="font-medium whitespace-nowrap text-ink-900">
                      {total}
                    </strong>{" "}
                    para a chave abaixo.
                    <DueAt date={order.paymentDueAt} />
                  </p>
                  <div className="mt-4">
                    <CopyCode code={pixKey} />
                  </div>
                  <p className="mt-4 font-store text-sm leading-relaxed text-ink-700">
                    Depois do Pix,{" "}
                    <WhatsAppLink href={whatsappLink}>
                      avise a gente no WhatsApp
                    </WhatsAppLink>{" "}
                    — a confirmação é feita à mão e o pedido aparece como pago
                    aqui em seguida.
                  </p>
                </>
              ) : mpEnabled ? (
                <>
                  <p className="mt-3 font-store text-[15px] leading-7 text-ink-800">
                    Pague com segurança pelo Mercado Pago.
                    <DueAt date={order.paymentDueAt} />
                  </p>
                  {mpUnavailable ? (
                    <Notice tone="claret" role="alert" className="mt-3">
                      Não foi possível iniciar o pagamento online agora. Tente
                      de novo em instantes — ou combine pelo WhatsApp aqui
                      embaixo.
                    </Notice>
                  ) : null}
                  <form action={payNowAction.bind(null, token)} className="mt-5">
                    <button
                      type="submit"
                      className={cx(btnPrimary, "w-full sm:w-auto sm:min-w-72")}
                    >
                      Pagar agora — Pix ou cartão
                    </button>
                  </form>
                  <p className="mt-5 font-store text-sm text-ink-700">
                    Prefere combinar pelo WhatsApp?{" "}
                    <WhatsAppLink href={whatsappLink}>Fale com a gente</WhatsAppLink>{" "}
                    e pague via Pix manual, como preferir.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-3 font-store text-[15px] leading-7 text-ink-800">
                    Vamos te chamar no WhatsApp para combinar o pagamento via
                    Pix.
                    <DueAt date={order.paymentDueAt} />
                  </p>
                  {whatsappLink ? (
                    <a
                      href={whatsappLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cx(btnPrimary, "mt-5")}
                    >
                      Chamar no WhatsApp agora
                    </a>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {showTracking ? (
            <Sheet
              eyebrow={order.status === "delivered" ? "Rastrear a entrega" : "A caminho"}
              headingId="rastreio-title"
              aria-labelledby="rastreio-title"
            >
              <p className="mt-3 flex items-center gap-2.5 font-display text-heading font-semibold text-espresso-900">
                <IconParcel className="h-5 w-5 shrink-0 text-gold-700" />
                {order.status === "delivered"
                  ? "Entregue. O código continua aqui."
                  : "Seu pedido está a caminho"}
              </p>
              <p className="mt-2 font-store text-sm leading-relaxed text-ink-700">
                Use o código abaixo para rastrear a entrega no site dos Correios
                ou da transportadora.
              </p>
              <div className="mt-4">
                <CopyCode code={order.trackingCode!} />
              </div>
            </Sheet>
          ) : null}
        </div>

        <Sheet
          eyebrow="Resumo do pedido"
          headingId="resumo-title"
          aria-labelledby="resumo-title"
          ornament
          sticky
        >
          <ol className="mt-4 divide-y divide-ivory-200">
            {order.items.map((item, index) => (
              <li key={item.sku} className="flex items-start gap-4 py-4 first:pt-0">
                <span className={cx(numeral, "pt-1")}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-display text-lg leading-tight font-semibold text-espresso-900">
                    {item.name}
                  </p>
                  <p className={cx(eyebrow, "mt-1")}>Cód. {item.sku}</p>
                  <p className="mt-1 font-store text-sm text-ink-700 tabular-nums">
                    {item.quantity} × {formatCentsBRL(item.unitPriceCents)}
                  </p>
                </div>
                <p className="shrink-0 font-store text-sm font-medium text-ink-900 tabular-nums">
                  {formatCentsBRL(item.totalCents)}
                </p>
              </li>
            ))}
          </ol>
          <TotalsList
            className="border-t border-ivory-300 pt-4"
            subtotalCents={order.subtotalCents}
            discountCents={order.discountCents}
            shippingCents={order.shippingCents}
            totalCents={order.totalCents}
          />
          <footer className="mt-6 flex flex-col items-center gap-3 border-t border-ivory-300 pt-5 text-center">
            <Ornament className="text-gold-500" />
            <p className="font-store text-sm text-ink-500">
              Guarde este link: ele é a sua chave para acompanhar o pedido.
            </p>
          </footer>
        </Sheet>
      </div>
    </div>
  );
}
