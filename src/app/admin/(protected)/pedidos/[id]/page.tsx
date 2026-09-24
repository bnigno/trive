import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from "@/core/orders/state-machine";
import { getFileStorage } from "@/adapters/storage";
import { PAYMENT_METHOD_LABELS } from "@/core/orders/payment-methods";
import { REFUND_STATE_LABELS, type RefundState } from "@/core/orders/refunds";
import { listReturnableItems } from "@/services/order-returns";
import { ReturnItemForm } from "./return-item-form";
import { neededByLabel, shipByLabel, trafficLight, type TrafficLight } from "@/core/shipping/needed-by";
import { spDayKey, spDayLabel, spTimeLabel } from "@/lib/sp-day";
import { getDb } from "@/db/client";
import { isOwner, requireUser } from "@/services/auth";
import { getOrderDetail } from "@/services/orders";
import { OrderTimeline } from "@/components/admin/order-timeline";
import { orderPublicUrl } from "@/services/wa-messaging";

import { CopyOrderLink } from "./copy-link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { OwnerOnly } from "../../owner-only";
import { channelLabel, formatDateTimeSP } from "../format";
import { OrderFinancialCard } from "./financial-card";
import { OrderMarginCard } from "./margin-card";
import { OrderActions } from "./order-actions";
import { PackForm } from "./pack-form";
import { DeliverForm } from "./deliver-form";
import { canDeliverWithPhoto, deliveryPhotoUrl } from "@/services/delivery";
import { getFeedbackForOrder } from "@/services/delivery-feedback";
import { listCouriers } from "@/services/couriers";
import { getRunEligibility, getStopForOrder } from "@/services/delivery-runs";
import { lateDeliveryForOrder } from "@/services/late-delivery";
import { listIssuedCouponsForOrder } from "@/services/coupons";
import { formatCouponValue, ORIGIN_LABELS } from "../../cupons/labels";
import { minutesLateLabel } from "@/core/delivery/lateness";
import { FAILURE_REASON_LABELS, STOP_STATUS_LABELS } from "@/core/delivery/state";
import { FEEDBACK_LABELS } from "@/core/orders/feedback";
import { giftNoteUrl } from "@/services/gifts";
import { editionCardsStatusByOrder } from "@/services/edition-cards";
import { packagePhotoUrl } from "@/services/packing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Detalhe do pedido",
};

/** Label pt-BR do método vindo do core; método desconhecido volta cru. */
function paymentMethodLabel(method: string): string {
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? method;
}

/** 'YYYY-MM-DD' (coluna date) → 'DD/MM/YYYY'. */
function formatIsoDateBR(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

const LIGHT_TONE: Record<TrafficLight, "danger" | "warning" | "success"> = { red: "danger", amber: "warning", green: "success" };

export default async function PedidoDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const db = getDb();
  const order = await getOrderDetail(db, id);
  if (!order) notFound();
  const feedback = order.status === "delivered" || order.status === "refunded" ? await getFeedbackForOrder(db, id) : null;
  // Saída do motoboy com GPS: a prova da entrega (hora, quem recebeu, ponto).
  const stop = order.deliveryWindow ? await getStopForOrder(db, id) : null;
  // O "Saiu" pergunta o motoboy; saiu sem ele, ainda dá para mandar o link (48 h, fora de saída aberta).
  const couriers = order.deliveryWindow ? await listCouriers(db) : [];
  const runEligibility = order.deliveryWindow?.dispatchedAt && couriers.length > 0 ? await getRunEligibility(db, { orderId: id }) : { canJoin: false, cameBack: false };
  const canJoinRun = runEligibility.canJoin;
  const late = stop?.stopStatus === "delivered" ? await lateDeliveryForOrder(db, id) : null;
  const issuedCoupons = await listIssuedCouponsForOrder(db, id);
  const returnableItems = await listReturnableItems(getDb(), order.id);
  const status = order.status as OrderStatus;
  // Os cartões: quantos o pedido tem e se os gerados ficaram velhos (a mesma
  // régua da tela dos cartões). "Gerar de novo" só enquanto a caixa está
  // aberta: depois de embalado, o cartão que foi já foi.
  const editionStatus = (await editionCardsStatusByOrder(db, [{ ...order, customerName: order.customer.fullName }])).get(order.id) ?? {
    cards: 0,
    isFirstPurchase: false,
    letter: false,
    stale: false,
  };
  // Dinheiro na entrega: a caixa é preparada com o pedido ainda pendente.
  const cashPending = status === "pending_payment" && order.paymentMethod === "cash";
  const boxOpen = (status === "paid" || status === "preparing" || cashPending) && !order.packagePhotoPath;
  const editionCardsStale = boxOpen && editionStatus.stale;
  // Reembolso mexe no financeiro (lançamento de saída): só o dono. A action
  // também barra pelo servidor — isto aqui é só para não mostrar botão morto.
  const owner = await isOwner();
  // Data marcada: o semáforo só faz sentido enquanto a peça não saiu.
  const todayKey = spDayKey(new Date());
  const isClosed = status === "shipped" || status === "delivered" || status === "canceled" || status === "refunded" || Boolean(order.deliveryWindow?.dispatchedAt);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Pedido #${order.orderNumber}`}
        subtitle={`Criado em ${formatDateTimeSP(order.createdAt)} · Canal: ${channelLabel(order.channel)}`}
        actions={
          <Link
            href="/admin/pedidos"
            className="text-sm text-zinc-600 hover:underline dark:text-zinc-400"
          >
            ← Voltar para pedidos
          </Link>
        }
      />

      <Card title="Link do pedido — envie ao cliente pelo WhatsApp">
        <div className="flex flex-col gap-2">
          <CopyOrderLink url={orderPublicUrl(order.publicToken)} />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {order.paymentMethod === "cash"
              ? "Por esse link o cliente acompanha o pedido. Pagamento em dinheiro na entrega — marque como pago aqui quando receber."
              : 'Por esse link o cliente acompanha o pedido e, quando estiver aguardando pagamento, paga com Pix ou cartão pelo Mercado Pago — o pedido vira "Pago" sozinho.'}
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="Itens">
            <Table headers={["SKU", "Produto", "Qtd.", "Unitário", "Total"]}>
              {order.items.map((item) => (
                <Tr key={item.id}>
                  <Td className="font-mono text-xs">
                    <Link
                      href={`/admin/estoque/${item.productVariantId}`}
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {item.skuSnapshot}
                    </Link>
                    {item.currentSku && item.currentSku !== item.skuSnapshot ? (
                      // O código mudou depois da venda: o snapshot é registro,
                      // o de hoje é o que o dono encontra no estoque e nos preços.
                      <span className="ml-1 text-zinc-500 dark:text-zinc-400">
                        · hoje {item.currentSku}
                      </span>
                    ) : null}
                  </Td>
                  <Td>{item.nameSnapshot}</Td>
                  <Td>{item.quantity}</Td>
                  <Td>
                    <Money cents={item.unitPriceCents} />
                  </Td>
                  <Td>
                    <Money cents={item.totalCents} className="font-medium" />
                  </Td>
                </Tr>
              ))}
            </Table>
            <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-8">
                <dt className="text-zinc-500 dark:text-zinc-400">Subtotal</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  <Money cents={order.subtotalCents} />
                </dd>
              </div>
              <div className="flex justify-between gap-8">
                <dt className="text-zinc-500 dark:text-zinc-400">
                  Desconto
                  {order.couponCode ? (
                    <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-500">
                      cupom {order.couponCode}
                    </span>
                  ) : null}
                </dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  − <Money cents={order.discountCents} />
                </dd>
              </div>
              <div className="flex justify-between gap-8">
                <dt className="text-zinc-500 dark:text-zinc-400">Frete</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  + <Money cents={order.shippingCents} />
                </dd>
              </div>
              <div className="flex justify-between gap-8 border-t border-zinc-200 pt-1.5 font-semibold dark:border-zinc-800">
                <dt className="text-zinc-900 dark:text-zinc-100">Total</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  <Money cents={order.totalCents} />
                </dd>
              </div>
            </dl>
          </Card>

          {/* Uma peça voltou: o pedido NÃO muda de status — não foi
              reembolsado, uma peça voltou. Só o dono vê (mexe em dinheiro). */}
          <OwnerOnly>
            <Card title="Devolução de peça">
              <ReturnItemForm orderId={order.id} items={returnableItems} />
            </Card>
          </OwnerOnly>

          <Card title="Pagamento">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-zinc-500 dark:text-zinc-400">Método</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {order.paymentMethod
                    ? paymentMethodLabel(order.paymentMethod)
                    : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-zinc-500 dark:text-zinc-400">Parcelas</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {order.installments !== null ? `${order.installments}×` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-zinc-500 dark:text-zinc-400">
                  Pagamento no Mercado Pago
                </dt>
                <dd className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
                  {order.mpPaymentId ?? "—"}
                </dd>
              </div>
              {/* Método, parcelas e id do MP são operacionais; o valor da taxa
                  é dinheiro do negócio e fica só com o dono. */}
              <OwnerOnly>
                <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                  <dt className="text-zinc-500 dark:text-zinc-400">
                    Taxa real do MP
                  </dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {order.mpFeeCents !== null ? (
                      <Money cents={order.mpFeeCents} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </OwnerOnly>
            </dl>
            {/* Estado do DINHEIRO do reembolso, que não é o mesmo que o status
                do pedido: 'Reembolsado' diz que a venda caiu, isto diz se o
                valor voltou. Só aparece quando há reembolso em jogo. */}
            {order.refundState && order.refundState !== "nao_aplicavel" ? (
              <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
                <strong>{REFUND_STATE_LABELS[order.refundState as RefundState]}</strong>
                {order.refundState === "devolvido" && order.refundedAt
                  ? ` — ${spDayLabel(spDayKey(order.refundedAt))} às ${spTimeLabel(order.refundedAt)}${order.mpRefundId ? ` · estorno ${order.mpRefundId}` : ""}`
                  : null}
                {order.refundState === "pendente"
                  ? " — pedimos o estorno ao Mercado Pago; a cliente é avisada quando o valor sair."
                  : null}
                {order.refundState === "falhou"
                  ? " — o Mercado Pago recusou. Devolva pelo painel dele e a cliente NÃO foi avisada."
                  : null}
              </p>
            ) : null}
            {status === "refunded" && order.refundState === "nao_aplicavel" ? (
              <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
                <strong>Devolução por fora</strong> — esta forma de pagamento não é estornada pelo
                sistema: confirme que o Pix (ou o dinheiro) voltou para a cliente.
              </p>
            ) : null}
          </Card>

          <OrderMarginCard order={order} />

          <OrderFinancialCard orderId={order.id} />

          {issuedCoupons.length > 0 ? (
            <Card title="Cupons deste pedido">
              <ul className="flex flex-col gap-2 text-sm">
                {issuedCoupons.map((coupon) => (
                  <li key={coupon.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono font-medium">{coupon.code}</span>
                    <span className="text-zinc-700 dark:text-zinc-300">{formatCouponValue(coupon)}</span>
                    <Badge tone="info">{ORIGIN_LABELS[coupon.origin]}</Badge>
                    <span className="text-xs text-zinc-500">
                      {coupon.usedCount > 0 ? "usado" : "não usado"}
                      {coupon.expiresAt ? ` · até ${formatDateTimeSP(coupon.expiresAt).slice(0, 10)}` : ""}
                      {coupon.isActive ? "" : " · desativado"}
                    </span>
                    {coupon.note ? <span className="block w-full text-xs text-zinc-500">{coupon.note}</span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {order.status === "delivered" || feedback ? (
            <Card title="Chegou bem?">
              {!feedback ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">Ainda não perguntado — a lista sai um dia depois da entrega, das 9h às 21h, se a cliente aceita avisos.</p>
              ) : feedback.answer ? (
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                  <Badge tone={feedback.answer === "amei" ? "success" : feedback.answer === "defeito" || feedback.answer === "falar" ? "danger" : "warning"}>
                    {FEEDBACK_LABELS[feedback.answer]}
                  </Badge>{" "}
                  {feedback.answeredAt ? `respondido em ${formatDateTimeSP(feedback.answeredAt)}` : ""}
                </p>
              ) : (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">Perguntado em {formatDateTimeSP(feedback.askedAt)} — sem resposta ainda.</p>
              )}
            </Card>
          ) : null}

          <Card title="Linha do tempo">
            <OrderTimeline
              history={order.history.map((entry) => ({
                fromStatus: entry.fromStatus,
                toStatus: entry.toStatus,
                reason: entry.reason,
                createdAt: entry.createdAt.toISOString(),
              }))}
              labels={ORDER_STATUS_LABELS}
            />
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card title="Resumo">
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Status</span>
                <StatusPill
                  label={ORDER_STATUS_LABELS[status] ?? order.status}
                  tone={orderStatusTone(order.status)}
                />
              </div>
              {order.paymentMethod === "cash" &&
              status === "pending_payment" ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950">
                  <Badge tone="warning" className="self-start">
                    Dinheiro na entrega
                  </Badge>
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    Sem prazo de expiração: marcar como pago = dinheiro na mão.
                  </p>
                </div>
              ) : null}
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Total</span>
                <Money
                  cents={order.totalCents}
                  className="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Canal</span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {channelLabel(order.channel)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">
                  Criado em
                </span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {formatDateTimeSP(order.createdAt)}
                </span>
              </div>
              {order.deliveryWindow ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-500 dark:text-zinc-400">Entrega</span>
                  <span className="text-right font-medium text-zinc-900 dark:text-zinc-100">
                    {order.deliveryWindow.rateName} — {order.deliveryWindow.label}
                    <span className="block text-xs font-normal text-zinc-500">pague até {order.deliveryWindow.cutoff.replace(/^0/, "").replace(":00", "h").replace(":", "h")}</span>
                  </span>
                </div>
              ) : null}
              {!order.deliveryWindow && order.shippingService ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-500 dark:text-zinc-400">Entrega</span>
                  <span className="text-right font-medium text-zinc-900 dark:text-zinc-100">
                    Correios — {order.shippingService}
                    {order.shippingQuoteId ? <span className="block text-xs font-normal text-zinc-500">cotação automática (SuperFrete) · poste e marque como enviado</span> : null}
                  </span>
                </div>
              ) : null}
              {stop ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-500 dark:text-zinc-400">Motoboy</span>
                  <span className="text-right text-zinc-900 dark:text-zinc-100">
                    <Link href={`/admin/pedidos/saidas/${stop.runId}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      Saída de {stop.courierName}
                    </Link>
                    <span className="block text-xs text-zinc-500">
                      {stop.stopStatus === "delivered"
                        ? `entregue ${stop.deliveredAt ? formatDateTimeSP(stop.deliveredAt) : ""}${stop.receivedBy ? `, recebido por ${stop.receivedBy}` : ""}${stop.deliveredPoint ? " · GPS ✓" : ""}${stop.withPhoto ? " · foto ✓" : " · sem foto"}`
                        : stop.stopStatus === "failed"
                          ? `não entregue: ${stop.failureReason ? FAILURE_REASON_LABELS[stop.failureReason] : ""}`
                          : STOP_STATUS_LABELS[stop.stopStatus].toLowerCase()}
                    </span>
                    {canJoinRun ? <span className="block text-xs text-amber-700 dark:text-amber-400">saiu de novo? escolha o motoboy em Ações</span> : null}
                    {late && late.lateness.minutesLate > 0 ? (
                      <span className={late.lateness.late ? "block text-xs text-amber-700 dark:text-amber-400" : "block text-xs text-zinc-500"}>
                        {late.lateness.late ? "atrasou" : "passou"} {minutesLateLabel(late.lateness.minutesLate)} da janela
                        {late.coupon
                          ? ` · cupom ${late.coupon.code} (${late.coupon.value}%${late.coupon.expiresAt ? `, até ${formatDateTimeSP(late.coupon.expiresAt).slice(0, 5)}` : ""}${late.coupon.isActive ? "" : ", desativado"})`
                          : late.lateness.late
                            ? " · sem cupom de desculpas"
                            : " · dentro da carência"}
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : canJoinRun ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-500 dark:text-zinc-400">Motoboy</span>
                  <span className="text-right text-amber-700 dark:text-amber-400">
                    não escolhido — sem GPS
                    <span className="block text-xs text-zinc-500">escolha quem levou em Ações</span>
                  </span>
                </div>
              ) : null}
              {order.neededBy ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-zinc-500 dark:text-zinc-400">Data marcada</span>
                  <span className="text-right font-medium text-zinc-900 dark:text-zinc-100">
                    {neededByLabel(order.neededBy, order.occasion)}
                    {order.shipBy && !isClosed ? (
                      <span className="block text-xs font-normal">
                        <Badge tone={LIGHT_TONE[trafficLight(order.shipBy, todayKey)]}>{shipByLabel(order.shipBy, todayKey)}</Badge>
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : null}
              {order.shippingTrackingCode ? (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Rastreio
                  </span>
                  <span className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
                    {order.shippingTrackingCode}
                  </span>
                </div>
              ) : null}
              {order.receiptPath ? (
                // Comprovante gerado quando o pagamento confirmou: o dono
                // abre/encaminha à mão quem não recebeu pelo WhatsApp.
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Comprovante
                  </span>
                  <a
                    href={`${getFileStorage().publicUrl(order.receiptPath)}?v=${order.paidAt?.getTime() ?? 0}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    Ver comprovante
                  </a>
                </div>
              ) : null}
              {order.cancelReason ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Motivo do cancelamento
                  </span>
                  <span className="text-zinc-900 dark:text-zinc-100">
                    {order.cancelReason}
                  </span>
                </div>
              ) : null}
              {order.note ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Observação
                  </span>
                  <span className="text-zinc-900 dark:text-zinc-100">
                    {order.note}
                  </span>
                </div>
              ) : null}
            </div>
          </Card>

          {order.isGift ? (
            <Card title="🎁 Presente — sem preço na embalagem">
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
                <dl className="grid gap-2">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-amber-800 dark:text-amber-300">
                      Para quem
                    </dt>
                    <dd className="text-zinc-900 dark:text-zinc-100">{order.giftRecipientName}</dd>
                  </div>
                  {order.giftDeliverBy ? (
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-amber-800 dark:text-amber-300">
                        Data desejada de entrega
                      </dt>
                      <dd className="text-zinc-900 dark:text-zinc-100">
                        {formatIsoDateBR(order.giftDeliverBy)}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-amber-800 dark:text-amber-300">
                      Bilhete
                    </dt>
                    <dd className="whitespace-pre-line italic text-zinc-900 dark:text-zinc-100">
                      {order.giftMessage ?? "Sem bilhete escrito — vai só o cartão da TRIVÉ."}
                    </dd>
                  </div>
                </dl>
              </div>
              {order.giftNotePath ? (
                <img
                  src={giftNoteUrl(getFileStorage(), order.giftNotePath, order.updatedAt)}
                  alt="Bilhete do presente"
                  className="mt-3 w-full max-w-xs rounded-md border border-zinc-200 dark:border-zinc-700"
                />
              ) : null}
              <Link
                href={`/admin/pedidos/${order.id}/bilhete`}
                className="mt-3 inline-flex rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Imprimir bilhete
              </Link>
            </Card>
          ) : null}

          <Card title="Cliente">
            {order.customer ? (
              <div className="flex flex-col gap-1 text-sm">
                <Link
                  href={`/admin/clientes/${order.customer.id}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {order.customer.fullName}
                </Link>
                {order.customer.phoneE164 ? (
                  <p className="text-zinc-700 dark:text-zinc-300">
                    {order.customer.phoneE164}
                  </p>
                ) : null}
                {order.customer.email ? (
                  <p className="text-zinc-500 dark:text-zinc-400">
                    {order.customer.email}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Cliente não encontrado.
              </p>
            )}
          </Card>

          {canDeliverWithPhoto(status, { dispatched: Boolean(order.deliveryWindow?.dispatchedAt), paymentMethod: order.paymentMethod }) ||
          (status === "delivered" && order.deliveredAt) ? (
            <Card title="Entrega">
              <DeliverForm
                orderId={order.id}
                photoUrl={order.deliveredPhotoPath ? deliveryPhotoUrl(getFileStorage(), order.deliveredPhotoPath, order.updatedAt) : null}
                receivedBy={order.receivedBy ?? null}
                deliveredAtLabel={order.deliveredAt ? formatDateTimeSP(order.deliveredAt) : null}
              />
            </Card>
          ) : null}

          {status === "paid" || status === "preparing" || cashPending ? (
            <Card title={cashPending ? "Embalagem (dinheiro na entrega)" : "Embalagem"}>
              <div className="flex flex-col gap-4">
                {cashPending ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {order.deliveryWindow?.dispatchedAt
                      ? "Dinheiro na entrega: o pacote já saiu com o motoboy — marque como pago só com o dinheiro na mão."
                      : "Dinheiro na entrega: embale e registre a foto agora — o pedido só sai com o motoboy depois dela; marque como pago só com o dinheiro na mão."}
                  </p>
                ) : null}
                <PackForm
                  orderId={order.id}
                  photoUrl={
                    order.packagePhotoPath && order.packedAt
                      ? packagePhotoUrl(getFileStorage(), order.packagePhotoPath, order.packedAt)
                      : null
                  }
                  packedAtLabel={order.packedAt ? formatDateTimeSP(order.packedAt) : null}
                />
                {editionStatus.cards > 0 || editionStatus.letter ? (
                  <EditionCardsLink
                    orderId={order.id}
                    generatedAt={order.editionCardsAt}
                    stale={editionCardsStale}
                    firstPurchase={editionStatus.isFirstPurchase}
                    letter={editionStatus.letter}
                    cards={editionStatus.cards}
                  />
                ) : null}
              </div>
            </Card>
          ) : order.packagePhotoPath && order.packedAt ? (
            <Card title="Embalagem">
              <img
                src={packagePhotoUrl(getFileStorage(), order.packagePhotoPath, order.packedAt)}
                alt="Foto do pacote"
                className="h-40 w-32 rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
              />
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Embalado em {formatDateTimeSP(order.packedAt)}.
              </p>
              {order.editionCardsAt ? (
                <div className="mt-3">
                  <EditionCardsLink
                    orderId={order.id}
                    generatedAt={order.editionCardsAt}
                    stale={editionCardsStale}
                    firstPurchase={editionStatus.isFirstPurchase}
                    letter={editionStatus.letter}
                    cards={editionStatus.cards}
                  />
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card title="Ações">
            <OrderActions
              orderId={order.id}
              status={status}
              paymentMethod={order.paymentMethod}
              mpPaymentId={order.mpPaymentId}
              trackingCode={order.shippingTrackingCode}
              canRefund={owner}
              packed={Boolean(order.packagePhotoPath)}
              motoboy={
                order.deliveryWindow && order.customer
                  ? {
                      customerName: order.customer.fullName,
                      dispatchedLabel: order.deliveryWindow.dispatchedAt ? formatDateTimeSP(order.deliveryWindow.dispatchedAt) : null,
                      couriers: couriers.map((c) => ({ id: c.id, name: c.name })),
                      canJoinRun,
                      // "Não consegui" só conta se foi depois da saída de agora (senão é da vez passada).
                      previousStop: runEligibility.cameBack ? "failed" : stop?.stopStatus === "canceled" ? "canceled" : null,
                      returned: status === "shipped" && !order.deliveryWindow.dispatchedAt && stop?.stopStatus === "failed",
                    }
                  : null
              }
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

/** O cartão de bolso que vai na caixa: "Gerar" antes, "Imprimir" depois — e "gerar de novo" se ficou velho. */
function EditionCardsLink({
  orderId,
  generatedAt,
  stale,
  firstPurchase,
  letter,
  cards,
}: {
  orderId: string;
  generatedAt: Date | null;
  stale: boolean;
  firstPurchase: boolean;
  /** A carta sai neste pedido (primeira compra E carta escrita). */
  letter: boolean;
  /** Quantas peças ganham cartão (0 = só a carta). */
  cards: number;
}) {
  // O que vai na caixa, no nome certo: "cartões da edição", "carta de estreia" ou os dois.
  const thing = cards > 0 ? (letter ? "a carta e os cartões da edição" : "os cartões da edição") : "a carta de estreia";
  const verb = generatedAt ? (stale ? "Gerar de novo" : "Imprimir") : "Gerar";
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      {firstPurchase ? (
        <span className="mr-2 inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {letter ? "1ª compra · carta de estreia" : "1ª compra"}
        </span>
      ) : null}
      <Link
        href={`/admin/pedidos/${orderId}/cartoes`}
        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        {`${verb} ${thing}`}
      </Link>
      {generatedAt ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {" · gerados em "}
          {formatDateTimeSP(generatedAt)}
          {stale ? " · o que sai na caixa mudou depois" : ""}
        </span>
      ) : (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {cards > 0 ? " · um cartão de bolso por peça, com a frase da curadora e o QR" : " · a carta assinada pela dona, para a primeira compra"}
        </span>
      )}
    </p>
  );
}
