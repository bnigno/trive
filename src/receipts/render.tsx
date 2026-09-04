// O comprovante de pagamento como imagem (1080×1350, formato de story):
// faixa noir com o lockup dourado, e o papel marfim com o pedido, as peças,
// os totais e a assinatura da maison. Apresentação pura: recebe ReceiptData e
// os assets por parâmetro e devolve o PNG (o serviço converte para JPEG).
// Desenhado pelo Satori (next/og): só flexbox, todo <div> com mais de um
// filho declara display:flex, texto misto vira uma string só, e todo texto
// vem de fontes embutidas.
import { ImageResponse } from "next/og";

import type { ReceiptAssets, ReceiptData } from "@/core/receipts/types";
import { formatCentsBRL } from "@/lib/money";

export const RECEIPT_WIDTH = 1080;
export const RECEIPT_HEIGHT = 1350;
/** Peças listadas por extenso; o resto vira "e mais N peças". */
const MAX_ITEMS = 6;

// Tokens da vitrine (src/app/globals.css) em hex: o Satori não lê CSS vars.
const C = {
  ivory100: "#faf7f0",
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  ink500: "#6e6656",
  espresso900: "#2f1c16",
  gold400: "#d4b96a",
  gold500: "#c0a050",
  gold800: "#6f561b",
  noir950: "#0b0a09",
  rose300: "#dbbba4",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

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

function formatPaidAt(date: Date): string {
  return `${dateFmt.format(date)} às ${timeFmt.format(date)}`;
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontFamily: SANS,
        fontSize: 24,
        color: muted ? C.ink500 : C.ink700,
        marginTop: 10,
      }}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Receipt({ data, lockup }: { data: ReceiptData; lockup: string }) {
  const shown = data.items.slice(0, MAX_ITEMS);
  const hidden = data.items.length - shown.length;

  return (
    <div
      style={{
        width: RECEIPT_WIDTH,
        height: RECEIPT_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory100,
        color: C.ink900,
        fontFamily: SANS,
      }}
    >
      {/* Faixa noir: o lockup e o eyebrow */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: C.noir950,
          padding: "52px 72px 44px",
        }}
      >
        <img src={lockup} width={440} height={196} alt="" />
        <div
          style={{
            marginTop: 18,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: 7,
            color: C.gold400,
          }}
        >
          PAGAMENTO CONFIRMADO
        </div>
      </div>

      {/* O papel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          padding: "52px 72px 44px",
        }}
      >
        <div
          style={{
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: 64,
            lineHeight: 1.05,
            color: C.espresso900,
          }}
        >
          Comprovante de pagamento
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: 16,
            fontSize: 26,
          }}
        >
          <span style={{ fontWeight: 500, color: C.ink900 }}>
            {`Pedido Nº ${data.orderNumber}`}
          </span>
          <span style={{ fontSize: 24, color: C.ink500 }}>
            {formatPaidAt(data.paidAt)}
          </span>
        </div>
        {/* O Laço: a fita rosé com o filete dourado */}
        <svg
          width="180"
          height="18"
          viewBox="0 0 240 24"
          fill="none"
          style={{ marginTop: 18 }}
        >
          <path
            d="M 2 12 C 40 -6, 80 30, 120 12 S 200 -6, 238 12"
            stroke={C.rose300}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M 2 17 C 40 -1, 80 35, 120 17 S 200 -1, 238 17"
            stroke={C.gold500}
            strokeWidth="0.8"
            strokeLinecap="round"
          />
        </svg>

        {/* As peças */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 28,
            borderTop: `1px solid ${C.ivory300}`,
          }}
        >
          {shown.map((item, index) => (
            <div
              key={`${item.sku}-${index}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                padding: "16px 0",
                borderBottom: `1px solid ${C.ivory300}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", maxWidth: 760 }}>
                <span
                  style={{
                    fontFamily: SERIF,
                    fontWeight: 600,
                    fontSize: 30,
                    lineHeight: 1.15,
                    color: C.espresso900,
                  }}
                >
                  {item.name}
                </span>
                <span style={{ marginTop: 4, fontSize: 20, color: C.ink500 }}>
                  {`${item.quantity} × ${formatCentsBRL(item.unitPriceCents)} · Cód. ${item.sku}`}
                </span>
              </div>
              <span style={{ fontSize: 26, fontWeight: 500, color: C.ink900 }}>
                {formatCentsBRL(item.totalCents)}
              </span>
            </div>
          ))}
          {hidden > 0 ? (
            <div
              style={{
                padding: "14px 0",
                fontSize: 22,
                color: C.ink500,
                borderBottom: `1px solid ${C.ivory300}`,
              }}
            >
              {`e mais ${hidden} ${hidden === 1 ? "peça" : "peças"}`}
            </div>
          ) : null}
        </div>

        {/* Os totais */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 14 }}>
          <Row label="Subtotal" value={formatCentsBRL(data.subtotalCents)} />
          {data.discountCents > 0 ? (
            <Row label="Desconto" value={`− ${formatCentsBRL(data.discountCents)}`} />
          ) : null}
          <Row
            label="Entrega"
            value={data.shippingCents === 0 ? "Grátis" : formatCentsBRL(data.shippingCents)}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginTop: 18,
              paddingTop: 18,
              borderTop: `1px solid ${C.ivory300}`,
            }}
          >
            <span
              style={{
                fontSize: 22,
                fontWeight: 500,
                letterSpacing: 5,
                color: C.ink900,
              }}
            >
              TOTAL
            </span>
            <span
              style={{
                fontFamily: SERIF,
                fontWeight: 600,
                fontSize: 60,
                lineHeight: 1,
                color: C.gold800,
              }}
            >
              {formatCentsBRL(data.totalCents)}
            </span>
          </div>
          <div style={{ marginTop: 14, fontSize: 22, color: C.ink700 }}>
            {`Pago via ${data.paymentLabel} · ${formatPaidAt(data.paidAt)}`}
          </div>
        </div>

        <div style={{ display: "flex", flexGrow: 1 }} />

        {/* Assinatura */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 26,
            borderTop: `1px solid ${C.ivory300}`,
          }}
        >
          <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: 4, color: C.ink900 }}>
            {data.storeName.toUpperCase()}
          </span>
          {data.storeCnpj ? (
            <span style={{ marginTop: 6, fontSize: 20, color: C.ink500 }}>
              {`CNPJ ${data.storeCnpj}`}
            </span>
          ) : null}
          <span
            style={{
              marginTop: 14,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 26,
              color: C.ink700,
            }}
          >
            Este comprovante não substitui a nota fiscal.
          </span>
          <span style={{ marginTop: 6, fontSize: 20, color: C.ink500 }}>
            Acompanhe pelo link enviado nesta conversa.
          </span>
        </div>
      </div>
    </div>
  );
}

/** PNG 1080×1350 do comprovante. Sem rede: fontes e lockup vêm de `assets`. */
export async function renderReceiptPng(
  data: ReceiptData,
  assets: ReceiptAssets,
): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const response = new ImageResponse(<Receipt data={data} lockup={lockup} />, {
    width: RECEIPT_WIDTH,
    height: RECEIPT_HEIGHT,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
