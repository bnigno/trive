"use client";

// Painel da cliente ao lado da conversa: quem é, o caderninho da vendedora,
// a sacola em andamento, os últimos pedidos e o resumo da transferência —
// para o dono nunca precisar perguntar o que a cliente já contou.
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { formatCentsBRL } from "@/lib/money";
import { formatTimeSP } from "./chat-format";
import { formatPhoneBR } from "./format";
import type { ChatContext } from "./use-chat-poll";

const ORDER_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  pending_payment: { label: "Aguardando pagamento", tone: "warning" },
  paid: { label: "Pago", tone: "success" },
  preparing: { label: "Em preparação", tone: "info" },
  shipped: { label: "Enviado", tone: "info" },
  delivered: { label: "Entregue", tone: "success" },
  canceled: { label: "Cancelado", tone: "danger" },
  refunded: { label: "Reembolsado", tone: "danger" },
};

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  timeZone: "America/Sao_Paulo",
});

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ContextPanel({
  context,
  phoneE164,
  isOwnerNotices,
  sellerName,
}: {
  context: ChatContext | null;
  phoneE164: string;
  isOwnerNotices: boolean;
  sellerName: string;
}) {
  if (isOwnerNotices) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm text-ink-700 dark:text-ink-300">
        <p className="font-medium text-ink-900 dark:text-ivory-100">Avisos internos</p>
        <p className="text-xs">
          Esta é a conversa com o seu próprio WhatsApp: aqui chegam os avisos de
          pedido, estoque e as transferências da {sellerName}. Não é uma cliente.
        </p>
      </div>
    );
  }

  const name = context?.customerName ?? context?.displayName ?? null;
  const cartTotal = (context?.cart ?? []).reduce(
    (sum, item) => sum + item.precoCents * item.quantidade,
    0,
  );

  return (
    <div className="flex flex-col gap-5 p-4 text-sm">
      <div className="flex flex-col gap-1">
        <p className="font-serif text-lg font-medium text-ink-900 dark:text-ivory-100">
          {name ?? "Cliente sem cadastro"}
        </p>
        {context?.displayName && context.customerName && context.displayName !== context.customerName ? (
          <p className="text-xs text-ink-500 dark:text-ink-300">
            No WhatsApp: {context.displayName}
          </p>
        ) : null}
        {phoneE164 ? (
          <a
            href={`https://wa.me/${phoneE164.replace(/\D/g, "")}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-700 underline decoration-ivory-400 underline-offset-2 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ivory-100"
          >
            {formatPhoneBR(phoneE164)}
          </a>
        ) : null}
        {context?.customerId ? (
          <Link
            href={`/admin/clientes/${context.customerId}`}
            className="mt-1 inline-flex w-fit items-center rounded-md border border-ivory-300 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ivory-100 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800"
          >
            Ver cadastro completo
          </Link>
        ) : (
          <p className="text-xs text-ink-400">
            Sem compra registrada neste número ainda.
          </p>
        )}
      </div>

      {context?.handoff ? (
        <Section title={`Resumo da ${sellerName}`}>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            <p className="font-medium">{context.handoff.motivo}</p>
            {context.handoff.resumo ? (
              <p className="mt-1 whitespace-pre-wrap">{context.handoff.resumo}</p>
            ) : null}
            <p className="mt-1 text-[11px] opacity-80">
              às {formatTimeSP(context.handoff.at)}
            </p>
          </div>
        </Section>
      ) : null}

      <Section title="Caderninho">
        {context && context.notes.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {context.notes.map((note) => (
              <li
                key={note}
                className="rounded-md bg-ivory-200/70 px-2.5 py-1.5 text-xs text-ink-800 dark:bg-ink-800 dark:text-ivory-100"
              >
                {note}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-400">
            A {sellerName} ainda não anotou nada sobre esta cliente — tamanho,
            cores e ocasião aparecem aqui quando ela contar.
          </p>
        )}
      </Section>

      <Section title="Sacola">
        {context && context.cart.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {context.cart.map((item) => (
              <div key={item.sku} className="flex items-start justify-between gap-2 text-xs">
                <span className="text-ink-800 dark:text-ivory-100">
                  {item.quantidade}× {item.nome}
                  {item.variacao ? (
                    <span className="text-ink-500 dark:text-ink-300"> · {item.variacao}</span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-ink-700 dark:text-ink-300">
                  {formatCentsBRL(item.precoCents * item.quantidade)}
                </span>
              </div>
            ))}
            <p className="mt-1 flex justify-between border-t border-ivory-300 pt-1.5 text-xs font-medium text-ink-900 dark:border-ink-700 dark:text-ivory-100">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatCentsBRL(cartTotal)}</span>
            </p>
          </div>
        ) : (
          <p className="text-xs text-ink-400">Sacola vazia por enquanto.</p>
        )}
      </Section>

      <Section title="Pedidos">
        {context && context.recentOrders.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {context.recentOrders.map((order) => {
              const status = ORDER_STATUS[order.status] ?? {
                label: order.status,
                tone: "neutral" as BadgeTone,
              };
              return (
                <li key={order.id}>
                  <Link
                    href={`/admin/pedidos/${order.id}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-ivory-300 px-2.5 py-1.5 text-xs transition-colors hover:bg-ivory-100 dark:border-ink-700 dark:hover:bg-ink-800"
                  >
                    <span className="flex flex-col">
                      <span className="font-medium text-ink-900 dark:text-ivory-100">
                        #{order.orderNumber}
                        <span className="ml-1.5 font-normal text-ink-500 dark:text-ink-300">
                          {dateFormatter.format(new Date(order.createdAt))}
                        </span>
                      </span>
                      <span className="tabular-nums text-ink-700 dark:text-ink-300">
                        {formatCentsBRL(order.totalCents)}
                      </span>
                    </span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-ink-400">Nenhum pedido ainda.</p>
        )}
      </Section>
    </div>
  );
}
