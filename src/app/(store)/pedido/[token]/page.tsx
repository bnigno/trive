// Página pública de acompanhamento do pedido, por token. Sempre dinâmica:
// o status muda a qualquer momento (pagamento, envio, expiração da reserva)
// e getPublicOrder já expira reservas vencidas antes de responder.
// PRIVACIDADE: getPublicOrder NÃO retorna dados pessoais — e esta página
// não adiciona nenhum (o link circula em encaminhamentos de WhatsApp).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Monogram } from "@/components/store/brand/monogram";
import { IconCheck, IconParcel } from "@/components/store/icons";
import { OrderStatusSteps } from "@/components/store/order-status-steps";
import { Ornament } from "@/components/store/ornament";
import { btnPrimary, eyebrow } from "@/components/store/styles";
import { Money } from "@/components/ui/money";
import { getDb } from "@/db/client";
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

const goldPanel =
  "mb-8 rounded-(--radius-hair) border border-gold-600/50 bg-gold-500/8 px-5 py-6";

const whatsappLinkClasses =
  "font-medium text-gold-800 underline decoration-gold-500/50 underline-offset-4 transition-colors duration-300 hover:decoration-gold-700";

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

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      {novo === "1" && !isCanceled ? (
        <div
          role="status"
          className="mb-8 flex items-start gap-4 rounded-(--radius-hair) border border-gold-600/40 bg-ivory-50 px-5 py-4"
        >
          <Monogram size={34} className="mt-0.5" />
          <div>
            <p className="font-display text-heading font-semibold text-ink-950">
              Pedido recebido
            </p>
            <p className="mt-1 text-sm leading-relaxed text-ink-700">
              Obrigado pela sua compra. Acompanhe tudo por esta página.
            </p>
          </div>
        </div>
      ) : null}

      <header className="mb-10">
        <p className={eyebrow}>Seu pedido</p>
        <h1 className="mt-2 font-display text-5xl font-semibold tracking-tight text-ink-950">
          #{order.orderNumber}
        </h1>
        <p className="mt-3 text-sm text-ink-500">
          Feito em {formatDueAt(order.createdAt)}
        </p>
      </header>

      {isCanceled ? (
        <div
          role="alert"
          className="mb-8 rounded-(--radius-hair) border border-claret-600/30 bg-claret-50 px-5 py-5"
        >
          <p className="font-display text-heading font-semibold text-claret-700">
            {order.status === "refunded"
              ? "Este pedido foi reembolsado"
              : "Este pedido foi cancelado"}
          </p>
          {reservationExpired ? (
            <p className="mt-2 text-sm leading-relaxed text-claret-700">
              A reserva dos produtos expirou porque o pagamento não foi
              confirmado dentro do prazo. Não se preocupe: nada foi cobrado, e
              você pode refazer o pedido quando quiser — é rapidinho.
            </p>
          ) : order.canceledReason ? (
            <p className="mt-2 text-sm leading-relaxed text-claret-700">
              Motivo: {order.canceledReason}. Se ficou alguma dúvida, fale com a
              gente — teremos prazer em ajudar.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-relaxed text-claret-700">
              Se ficou alguma dúvida, fale com a gente — teremos prazer em
              ajudar.
            </p>
          )}
          {reservationExpired ? (
            <Link href="/produtos" className={`${btnPrimary} mt-5`}>
              Refazer meu pedido
            </Link>
          ) : null}
        </div>
      ) : (
        <section
          aria-label="Andamento do pedido"
          className="mb-8 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-4 py-6 sm:px-6"
        >
          <OrderStatusSteps status={order.status} />
        </section>
      )}

      {mpApproved ? (
        <div
          role="status"
          className="mb-8 rounded-(--radius-hair) border border-laurel-600/40 bg-ivory-50 px-5 py-5"
        >
          <p className="flex items-center gap-2.5 font-display text-heading font-semibold text-laurel-700">
            <IconCheck className="h-5 w-5 shrink-0 text-laurel-600" />
            Pagamento recebido! Processando confirmação…
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-700">
            O Mercado Pago aprovou o seu pagamento. Em instantes o pedido
            aparece como pago aqui — pode atualizar a página para conferir.
          </p>
        </div>
      ) : null}

      {isPendingPayment && !mpApproved ? (
        isCash ? (
          <section className={goldPanel}>
            <h2 className="font-display text-heading font-semibold text-ink-950">
              Como pagar
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-ink-800">
              Você paga em{" "}
              <strong className="font-medium text-ink-900">
                dinheiro na entrega
              </strong>{" "}
              — vamos combinar os detalhes pelo WhatsApp. Tenha{" "}
              <strong className="font-medium whitespace-nowrap text-ink-900">
                <Money cents={order.totalCents} />
              </strong>{" "}
              em mãos ao receber.
            </p>
            {whatsappLink ? (
              <a
                href={whatsappLink}
                target="_blank"
                rel="noopener noreferrer"
                className={`${btnPrimary} mt-5`}
              >
                Chamar no WhatsApp
              </a>
            ) : null}
          </section>
        ) : showPixManual ? (
          <section className={goldPanel}>
            <h2 className="font-display text-heading font-semibold text-ink-950">
              Como pagar
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-ink-800">
              Faça um Pix de{" "}
              <strong className="font-medium whitespace-nowrap text-ink-900">
                <Money cents={order.totalCents} />
              </strong>{" "}
              para a chave abaixo.
              {order.paymentDueAt ? (
                <>
                  {" "}
                  Reserva válida até{" "}
                  <strong className="font-medium whitespace-nowrap text-ink-900">
                    {formatDueAt(order.paymentDueAt)}
                  </strong>
                  .
                </>
              ) : null}
            </p>
            <div className="mt-4">
              <CopyCode code={pixKey} />
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink-700">
              Depois de fazer o Pix,{" "}
              {whatsappLink ? (
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={whatsappLinkClasses}
                >
                  avise a gente no WhatsApp
                </a>
              ) : (
                "avise a gente no WhatsApp"
              )}{" "}
              — a confirmação é manual e o pedido aparece como pago aqui em
              seguida.
            </p>
          </section>
        ) : mpEnabled ? (
          <section className={goldPanel}>
            <h2 className="font-display text-heading font-semibold text-ink-950">
              Como pagar
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-ink-800">
              Pague com segurança pelo Mercado Pago.
              {order.paymentDueAt ? (
                <>
                  {" "}
                  Reserva válida até{" "}
                  <strong className="font-medium whitespace-nowrap text-ink-900">
                    {formatDueAt(order.paymentDueAt)}
                  </strong>
                  .
                </>
              ) : null}
            </p>
            {mpUnavailable ? (
              <p
                role="alert"
                className="mt-3 rounded-(--radius-soft) border border-claret-600/40 bg-claret-50 px-3 py-2 text-sm text-claret-700"
              >
                Não foi possível iniciar o pagamento online agora. Tente de
                novo em instantes — ou combine pelo WhatsApp aqui embaixo.
              </p>
            ) : null}
            <form action={payNowAction.bind(null, token)} className="mt-5">
              <button
                type="submit"
                className={`${btnPrimary} w-full sm:w-auto sm:min-w-72`}
              >
                Pagar agora (Pix ou cartão)
              </button>
            </form>
            <p className="mt-5 text-sm text-ink-700">
              Prefere combinar pelo WhatsApp?{" "}
              {whatsappLink ? (
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={whatsappLinkClasses}
                >
                  Fale com a gente
                </a>
              ) : (
                "Fale com a gente"
              )}{" "}
              e pague via Pix manual, como preferir.
            </p>
          </section>
        ) : (
          <section className={goldPanel}>
            <h2 className="font-display text-heading font-semibold text-ink-950">
              Como pagar
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-ink-800">
              Vamos te chamar no WhatsApp para combinar o pagamento via Pix.
              {order.paymentDueAt ? (
                <>
                  {" "}
                  Reserva válida até{" "}
                  <strong className="font-medium whitespace-nowrap text-ink-900">
                    {formatDueAt(order.paymentDueAt)}
                  </strong>
                  .
                </>
              ) : null}
            </p>
            {whatsappLink ? (
              <a
                href={whatsappLink}
                target="_blank"
                rel="noopener noreferrer"
                className={`${btnPrimary} mt-5`}
              >
                Chamar no WhatsApp agora
              </a>
            ) : null}
          </section>
        )
      ) : null}

      {(order.status === "shipped" || order.status === "delivered") &&
      order.trackingCode ? (
        <section className="mb-8 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-5 py-5">
          <h2 className="flex items-center gap-2.5 font-display text-heading font-semibold text-ink-950">
            <IconParcel className="h-5 w-5 shrink-0 text-gold-700" />
            {order.status === "delivered"
              ? "Rastreamento da entrega"
              : "Seu pedido está a caminho"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-700">
            Use o código abaixo para rastrear a entrega no site dos Correios ou
            da transportadora.
          </p>
          <div className="mt-4">
            <CopyCode code={order.trackingCode} />
          </div>
        </section>
      ) : null}

      <section className="mb-10 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50">
        <h2 className="border-b border-ivory-300 px-5 py-4 font-display text-heading font-semibold text-ink-950">
          Itens do pedido
        </h2>
        <ul className="divide-y divide-ivory-200">
          {order.items.map((item) => (
            <li
              key={item.sku}
              className="flex items-start justify-between gap-4 px-5 py-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink-900">{item.name}</p>
                <p className="mt-0.5 text-xs text-ink-500">Cód. {item.sku}</p>
                <p className="mt-1 text-sm text-ink-700">
                  {item.quantity} × <Money cents={item.unitPriceCents} />
                </p>
              </div>
              <Money
                cents={item.totalCents}
                className="shrink-0 font-medium text-ink-900"
              />
            </li>
          ))}
        </ul>
        <dl className="space-y-2 border-t border-ivory-300 px-5 py-4 text-sm">
          <div className="flex justify-between text-ink-700">
            <dt>Subtotal</dt>
            <dd>
              <Money cents={order.subtotalCents} />
            </dd>
          </div>
          {order.discountCents > 0 ? (
            <div className="flex justify-between text-ink-700">
              <dt>Desconto</dt>
              <dd>
                − <Money cents={order.discountCents} />
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-ink-700">
            <dt>Frete</dt>
            <dd>
              {order.shippingCents === 0 ? (
                "Grátis"
              ) : (
                <Money cents={order.shippingCents} />
              )}
            </dd>
          </div>
          <div className="flex justify-between border-t border-ivory-300 pt-3 text-base">
            <dt className="font-medium text-ink-900">Total</dt>
            <dd>
              <Money
                cents={order.totalCents}
                className="font-semibold text-ink-900"
              />
            </dd>
          </div>
        </dl>
      </section>

      <footer className="flex flex-col items-center gap-4 pb-4 text-center">
        <Ornament className="text-gold-500" />
        <p className="text-sm text-ink-500">
          Guarde este link para acompanhar seu pedido.
        </p>
      </footer>
    </div>
  );
}
