// Templates de e-mail transacional da loja: funções PURAS que recebem dados
// prontos e retornam { subject, html, text } em pt-BR. HTML simples com
// estilos inline (560px, sem imagens externas) — máxima compatibilidade com
// clientes de e-mail. Dinheiro sempre via formatCentsBRL; datas exibidas no
// fuso America/Sao_Paulo.
import { formatCentsBRL } from "@/lib/money";

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export interface EmailOrderItem {
  name: string;
  quantity: number;
  unitPriceCents: number;
}

interface BaseOrderEmailInput {
  orderNumber: number;
  customerName: string;
  items: EmailOrderItem[];
  totalCents: number;
  /** Página pública de acompanhamento do pedido (/pedido/[token]). */
  publicUrl: string;
  storeName: string;
}

export interface OrderConfirmedEmailInput extends BaseOrderEmailInput {
  paymentDueAt?: Date;
}

export type PaymentApprovedEmailInput = BaseOrderEmailInput;

export interface OrderShippedEmailInput extends BaseOrderEmailInput {
  trackingCode?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const spDateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Ex.: "25/08/2026 às 14:30" (horário de Brasília). */
export function formatDateTimeSP(date: Date): string {
  return spDateTimeFormatter.format(date).replace(", ", " às ");
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function itemsTableHtml(items: EmailOrderItem[], totalCents: number): string {
  const rows = items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#333;">
            ${escapeHtml(item.name)}
            <span style="color:#888;">× ${item.quantity}</span>
          </td>
          <td align="right" style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#333;white-space:nowrap;">
            ${escapeHtml(formatCentsBRL(item.unitPriceCents * item.quantity))}
          </td>
        </tr>`,
    )
    .join("");
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;">
        ${rows}
        <tr>
          <td style="padding:12px 0 0;font-size:15px;color:#111;font-weight:bold;">Total</td>
          <td align="right" style="padding:12px 0 0;font-size:15px;color:#111;font-weight:bold;white-space:nowrap;">
            ${escapeHtml(formatCentsBRL(totalCents))}
          </td>
        </tr>
      </table>`;
}

function itemsText(items: EmailOrderItem[], totalCents: number): string {
  const lines = items.map(
    (item) =>
      `- ${item.name} × ${item.quantity} — ${formatCentsBRL(item.unitPriceCents * item.quantity)}`,
  );
  lines.push(`Total: ${formatCentsBRL(totalCents)}`);
  return lines.join("\n");
}

function renderLayout(opts: {
  storeName: string;
  heading: string;
  greeting: string;
  introHtml: string;
  itemsHtml: string;
  ctaLabel: string;
  publicUrl: string;
  outroHtml?: string;
}): string {
  const url = escapeHtml(opts.publicUrl);
  return `
  <div style="margin:0 auto;max-width:560px;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;background-color:#ffffff;color:#333;">
    <p style="margin:0 0 24px;font-size:18px;font-weight:bold;color:#111;">${escapeHtml(opts.storeName)}</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111;">${opts.heading}</h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${opts.greeting}</p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${opts.introHtml}</p>
    ${opts.itemsHtml}
    ${opts.outroHtml ?? ""}
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:12px 24px;background-color:#111111;color:#ffffff;font-size:15px;text-decoration:none;border-radius:6px;">${escapeHtml(opts.ctaLabel)}</a>
    </p>
    <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#888;">
      Se o botão não funcionar, copie e cole este endereço no navegador:<br />
      <a href="${url}" style="color:#555;">${url}</a>
    </p>
    <p style="margin:0;font-size:13px;color:#888;">Com carinho,<br />${escapeHtml(opts.storeName)}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function orderConfirmedEmail(
  input: OrderConfirmedEmailInput,
): EmailTemplate {
  const subject = `Recebemos seu pedido #${input.orderNumber} — ${input.storeName}`;
  const dueLine = input.paymentDueAt
    ? `Conclua o pagamento até ${formatDateTimeSP(input.paymentDueAt)} (horário de Brasília) para garantir a reserva dos seus itens.`
    : "Assim que o pagamento for confirmado, começamos a preparar tudo.";

  const html = renderLayout({
    storeName: input.storeName,
    heading: `Pedido #${input.orderNumber} recebido!`,
    greeting: `Olá, ${escapeHtml(firstName(input.customerName))}!`,
    introHtml:
      "Que alegria receber seu pedido! Ele já está registrado e seus itens estão reservados. Aqui está o resumo:",
    itemsHtml: itemsTableHtml(input.items, input.totalCents),
    outroHtml: `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(dueLine)}</p>`,
    ctaLabel: "Acompanhar meu pedido",
    publicUrl: input.publicUrl,
  });

  const text = [
    `Olá, ${firstName(input.customerName)}!`,
    "",
    `Recebemos seu pedido #${input.orderNumber}. Ele já está registrado e seus itens estão reservados.`,
    "",
    itemsText(input.items, input.totalCents),
    "",
    dueLine,
    "",
    `Acompanhe seu pedido: ${input.publicUrl}`,
    "",
    `Com carinho, ${input.storeName}`,
  ].join("\n");

  return { subject, html, text };
}

export function paymentApprovedEmail(
  input: PaymentApprovedEmailInput,
): EmailTemplate {
  const subject = `Pagamento aprovado! Pedido #${input.orderNumber} confirmado — ${input.storeName}`;

  const html = renderLayout({
    storeName: input.storeName,
    heading: `Pagamento do pedido #${input.orderNumber} aprovado!`,
    greeting: `Olá, ${escapeHtml(firstName(input.customerName))}!`,
    introHtml:
      "Boa notícia: seu pagamento foi aprovado e o pedido está confirmado. Vamos preparar tudo com muito cuidado e avisamos assim que ele for enviado.",
    itemsHtml: itemsTableHtml(input.items, input.totalCents),
    ctaLabel: "Acompanhar meu pedido",
    publicUrl: input.publicUrl,
  });

  const text = [
    `Olá, ${firstName(input.customerName)}!`,
    "",
    `Seu pagamento foi aprovado e o pedido #${input.orderNumber} está confirmado.`,
    "Vamos preparar tudo com muito cuidado e avisamos assim que ele for enviado.",
    "",
    itemsText(input.items, input.totalCents),
    "",
    `Acompanhe seu pedido: ${input.publicUrl}`,
    "",
    `Com carinho, ${input.storeName}`,
  ].join("\n");

  return { subject, html, text };
}

export function orderShippedEmail(input: OrderShippedEmailInput): EmailTemplate {
  const subject = `Seu pedido #${input.orderNumber} está a caminho — ${input.storeName}`;
  const trackingHtml = input.trackingCode
    ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">Código de rastreio: <strong>${escapeHtml(input.trackingCode)}</strong></p>`
    : "";

  const html = renderLayout({
    storeName: input.storeName,
    heading: `Pedido #${input.orderNumber} enviado!`,
    greeting: `Olá, ${escapeHtml(firstName(input.customerName))}!`,
    introHtml:
      "Seu pedido saiu para entrega e está a caminho. Aqui está o resumo do que foi enviado:",
    itemsHtml: itemsTableHtml(input.items, input.totalCents),
    outroHtml: trackingHtml,
    ctaLabel: "Acompanhar meu pedido",
    publicUrl: input.publicUrl,
  });

  const textLines = [
    `Olá, ${firstName(input.customerName)}!`,
    "",
    `Seu pedido #${input.orderNumber} foi enviado e está a caminho.`,
    "",
    itemsText(input.items, input.totalCents),
  ];
  if (input.trackingCode) {
    textLines.push("", `Código de rastreio: ${input.trackingCode}`);
  }
  textLines.push(
    "",
    `Acompanhe seu pedido: ${input.publicUrl}`,
    "",
    `Com carinho, ${input.storeName}`,
  );

  return { subject, html, text: textLines.join("\n") };
}
