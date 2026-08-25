// Página pública de acompanhamento do pedido, por token. Sempre dinâmica:
// o status muda a qualquer momento (pagamento, envio, expiração da reserva)
// e getPublicOrder já expira reservas vencidas antes de responder.
// PRIVACIDADE: getPublicOrder NÃO retorna dados pessoais — e esta página
// não adiciona nenhum (o link circula em encaminhamentos de WhatsApp).
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OrderStatusSteps } from "@/components/store/order-status-steps";
import { Money } from "@/components/ui/money";
import { getDb } from "@/db/client";
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

/** Monta o link wa.me a partir da setting store_whatsapp (formato livre). */
function waMeLink(rawPhone: unknown, orderNumber: number): string | null {
  if (typeof rawPhone !== "string") return null;
  let digits = rawPhone.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // Número nacional (DDD + número) → prefixa o código do Brasil.
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  const text = encodeURIComponent(
    `Olá! Fiz o pedido #${orderNumber} e quero combinar o pagamento`,
  );
  return `https://wa.me/${digits}?text=${text}`;
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
  const mpEnabled = isPendingPayment ? await isMpEnabled(db) : false;

  const settings = isPendingPayment
    ? await getSettingsMap(db, ["store_whatsapp"])
    : {};
  const whatsappLink = isPendingPayment
    ? waMeLink(settings["store_whatsapp"], order.orderNumber)
    : null;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      {novo === "1" && !isCanceled ? (
        <div
          role="status"
          className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900 dark:bg-amber-950/40"
        >
          <p className="text-lg font-semibold text-amber-900 dark:text-amber-300">
            Pedido recebido! 🎉
          </p>
          <p className="mt-1 text-sm leading-relaxed text-amber-800 dark:text-amber-400">
            Obrigado pela sua compra. Acompanhe tudo por esta página.
          </p>
        </div>
      ) : null}

      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Seu pedido
        </p>
        <h1 className="mt-1 text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          #{order.orderNumber}
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Feito em {formatDueAt(order.createdAt)}
        </p>
      </header>

      {isCanceled ? (
        <div
          role="alert"
          className="mb-8 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 dark:border-red-900 dark:bg-red-950/40"
        >
          <p className="text-lg font-semibold text-red-800 dark:text-red-300">
            {order.status === "refunded"
              ? "Este pedido foi reembolsado"
              : "Este pedido foi cancelado"}
          </p>
          {reservationExpired ? (
            <p className="mt-2 text-sm leading-relaxed text-red-700 dark:text-red-400">
              A reserva dos produtos expirou porque o pagamento não foi
              confirmado dentro do prazo. Não se preocupe: nada foi cobrado, e
              você pode refazer o pedido quando quiser — é rapidinho.
            </p>
          ) : order.canceledReason ? (
            <p className="mt-2 text-sm leading-relaxed text-red-700 dark:text-red-400">
              Motivo: {order.canceledReason}. Se ficou alguma dúvida, fale com a
              gente — teremos prazer em ajudar.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-relaxed text-red-700 dark:text-red-400">
              Se ficou alguma dúvida, fale com a gente — teremos prazer em
              ajudar.
            </p>
          )}
          {reservationExpired ? (
            <a
              href="/produtos"
              className="mt-4 inline-block rounded-full bg-amber-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-800"
            >
              Refazer meu pedido
            </a>
          ) : null}
        </div>
      ) : (
        <section
          aria-label="Andamento do pedido"
          className="mb-8 rounded-2xl border border-zinc-200 bg-white px-4 py-6 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <OrderStatusSteps status={order.status} />
        </section>
      )}

      {mpApproved ? (
        <div
          role="status"
          className="mb-8 rounded-2xl border-2 border-emerald-300 bg-emerald-50 px-5 py-5 dark:border-emerald-800 dark:bg-emerald-950/40"
        >
          <p className="text-lg font-semibold text-emerald-900 dark:text-emerald-300">
            Pagamento recebido! Processando confirmação…
          </p>
          <p className="mt-1 text-sm leading-relaxed text-emerald-800 dark:text-emerald-400">
            O Mercado Pago aprovou o seu pagamento. Em instantes o pedido
            aparece como pago aqui — pode atualizar a página para conferir.
          </p>
        </div>
      ) : null}

      {isPendingPayment && !mpApproved && order.paymentDueAt ? (
        mpEnabled ? (
          <section className="mb-8 rounded-2xl border-2 border-amber-300 bg-amber-50 px-5 py-5 dark:border-amber-800 dark:bg-amber-950/40">
            <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-300">
              Como pagar
            </h2>
            <p className="mt-2 text-base leading-relaxed text-amber-900/90 dark:text-amber-200/90">
              Pague com segurança pelo Mercado Pago. Reserva válida até{" "}
              <strong className="whitespace-nowrap">
                {formatDueAt(order.paymentDueAt)}
              </strong>
              .
            </p>
            {mpUnavailable ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
              >
                Não foi possível iniciar o pagamento online agora. Tente de
                novo em instantes — ou combine pelo WhatsApp aqui embaixo.
              </p>
            ) : null}
            <form action={payNowAction.bind(null, token)} className="mt-4">
              <button
                type="submit"
                className="flex w-full items-center justify-center rounded-full bg-amber-700 px-6 py-4 text-base font-semibold text-white transition-colors hover:bg-amber-800 sm:w-auto sm:min-w-72"
              >
                Pagar agora (Pix ou cartão)
              </button>
            </form>
            <p className="mt-4 text-sm text-amber-900/90 dark:text-amber-200/90">
              Prefere combinar pelo WhatsApp?{" "}
              {whatsappLink ? (
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline"
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
          <section className="mb-8 rounded-2xl border-2 border-amber-300 bg-amber-50 px-5 py-5 dark:border-amber-800 dark:bg-amber-950/40">
            <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-300">
              Como pagar
            </h2>
            <p className="mt-2 text-base leading-relaxed text-amber-900/90 dark:text-amber-200/90">
              Vamos te chamar no WhatsApp para combinar o pagamento via Pix.
              Reserva válida até{" "}
              <strong className="whitespace-nowrap">
                {formatDueAt(order.paymentDueAt)}
              </strong>
              .
            </p>
            {whatsappLink ? (
              <a
                href={whatsappLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block rounded-full bg-amber-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-800"
              >
                Chamar no WhatsApp agora
              </a>
            ) : null}
          </section>
        )
      ) : null}

      {(order.status === "shipped" || order.status === "delivered") &&
      order.trackingCode ? (
        <section className="mb-8 rounded-2xl border border-zinc-200 bg-white px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {order.status === "delivered"
              ? "Rastreamento da entrega"
              : "Seu pedido está a caminho 📦"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Use o código abaixo para rastrear a entrega no site dos Correios ou
            da transportadora.
          </p>
          <div className="mt-3">
            <CopyCode code={order.trackingCode} />
          </div>
        </section>
      ) : null}

      <section className="mb-8 rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="border-b border-zinc-200 px-5 py-4 text-lg font-semibold text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
          Itens do pedido
        </h2>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {order.items.map((item) => (
            <li
              key={item.sku}
              className="flex items-start justify-between gap-4 px-5 py-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {item.name}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Cód. {item.sku}
                </p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {item.quantity} × <Money cents={item.unitPriceCents} />
                </p>
              </div>
              <Money
                cents={item.totalCents}
                className="shrink-0 font-semibold text-zinc-900 dark:text-zinc-100"
              />
            </li>
          ))}
        </ul>
        <dl className="space-y-2 border-t border-zinc-200 px-5 py-4 text-sm dark:border-zinc-800">
          <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
            <dt>Subtotal</dt>
            <dd>
              <Money cents={order.subtotalCents} />
            </dd>
          </div>
          {order.discountCents > 0 ? (
            <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
              <dt>Desconto</dt>
              <dd>
                − <Money cents={order.discountCents} />
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
            <dt>Frete</dt>
            <dd>
              {order.shippingCents === 0 ? (
                "Grátis"
              ) : (
                <Money cents={order.shippingCents} />
              )}
            </dd>
          </div>
          <div className="flex justify-between border-t border-zinc-200 pt-3 text-base font-bold dark:border-zinc-800">
            <dt className="text-zinc-900 dark:text-zinc-100">Total</dt>
            <dd>
              <Money
                cents={order.totalCents}
                className="text-amber-800 dark:text-amber-400"
              />
            </dd>
          </div>
        </dl>
      </section>

      <footer className="pb-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Guarde este link para acompanhar seu pedido. 💛
      </footer>
    </main>
  );
}
