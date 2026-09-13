// "Bom dia da maison" como imagem (1080×1350): faixa noir com o lockup, a
// frase do dia, as vendas de ontem em destaque, o que espera o dono, o que
// a vendedora fez, estoque baixo e a peça da semana. Apresentação pura —
// recebe DailyDigestData e os assets (mesmas fontes do comprovante). Regras
// do Satori: só flexbox, todo <div> com mais de um filho declara
// display:flex, texto misto vira uma string só, nada vem da rede.
import { ImageResponse } from "next/og";

import type { DailyDigestData } from "@/core/digest/types";
import type { ReceiptAssets } from "@/core/receipts/types";
import { formatCentsBRL, formatUsdCents } from "@/lib/money";

export const DIGEST_WIDTH = 1080;
export const DIGEST_HEIGHT = 1350;

// Tokens da vitrine (src/app/globals.css) em hex: o Satori não lê CSS vars.
const C = {
  ivory100: "#faf7f0",
  ivory200: "#f3eee2",
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  ink500: "#6e6656",
  espresso900: "#2f1c16",
  gold400: "#d4b96a",
  gold500: "#c0a050",
  gold800: "#6f561b",
  noir950: "#0b0a09",
  laurel700: "#33573f",
  claret600: "#963b31",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

const timeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
});

function Eyebrow({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: SANS,
        fontSize: 18,
        fontWeight: 500,
        letterSpacing: 6,
        color: C.gold800,
      }}
    >
      {children}
    </div>
  );
}

function Stat({
  value,
  label,
  tone = "ink",
  width,
}: {
  value: string;
  label: string;
  tone?: "ink" | "gold" | "laurel" | "claret";
  width: number;
}) {
  const color =
    tone === "gold"
      ? C.gold800
      : tone === "laurel"
        ? C.laurel700
        : tone === "claret"
          ? C.claret600
          : C.espresso900;
  return (
    <div style={{ display: "flex", flexDirection: "column", width }}>
      <span
        style={{
          fontFamily: SERIF,
          fontWeight: 600,
          fontSize: 54,
          lineHeight: 1,
          color,
        }}
      >
        {value}
      </span>
      <span style={{ marginTop: 8, fontFamily: SANS, fontSize: 20, color: C.ink500 }}>
        {label}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        marginTop: 14,
        paddingTop: 12,
        borderTop: `1px solid ${C.ivory300}`,
      }}
    >
      <Eyebrow>{title}</Eyebrow>
      <div style={{ display: "flex", marginTop: 12 }}>{children}</div>
    </div>
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function Digest({ data, lockup }: { data: DailyDigestData; lockup: string }) {
  const { sales, waiting, bot } = data;
  const hadSales = sales.paidOrders > 0;

  return (
    <div
      style={{
        width: DIGEST_WIDTH,
        height: DIGEST_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory100,
        color: C.ink900,
        fontFamily: SANS,
      }}
    >
      {/* Faixa noir */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: C.noir950,
          padding: "26px 72px 22px",
        }}
      >
        <img src={lockup} width={270} height={120} alt="" />
        <div
          style={{
            marginTop: 14,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: 7,
            color: C.gold400,
          }}
        >
          BOM DIA DA MAISON
        </div>
        <div style={{ marginTop: 8, fontSize: 22, color: C.ivory300 }}>
          {data.dayLabel}
        </div>
      </div>

      {/* O papel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          padding: "26px 72px 24px",
        }}
      >
        <div
          style={{
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 36,
            lineHeight: 1.2,
            color: C.espresso900,
          }}
        >
          {data.opening}
        </div>

        {/* Vendas de ontem */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 24 }}>
          <Eyebrow>VENDAS DE ONTEM</Eyebrow>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginTop: 8,
            }}
          >
            <span
              style={{
                fontFamily: SERIF,
                fontWeight: 600,
                fontSize: 92,
                lineHeight: 1,
                color: hadSales ? C.gold800 : C.ink500,
              }}
            >
              {formatCentsBRL(sales.revenueCents)}
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 24, color: C.ink700 }}>
            {hadSales
              ? `${sales.paidOrders} ${plural(sales.paidOrders, "pedido pago", "pedidos pagos")} · ticket ${formatCentsBRL(sales.averageTicketCents)} · ${sales.newOrders} ${plural(sales.newOrders, "pedido novo", "pedidos novos")}`
              : `Nenhum pagamento ontem · ${sales.newOrders} ${plural(sales.newOrders, "pedido novo", "pedidos novos")}`}
          </div>
        </div>

        <Section title="AGUARDANDO VOCÊ">
          <Stat
            width={300}
            value={String(waiting.pendingPayment)}
            label="a pagar"
            tone={waiting.pendingPayment > 0 ? "gold" : "ink"}
          />
          <Stat
            width={300}
            value={String(waiting.toPack)}
            label="a embalar"
            tone={waiting.toPack > 0 ? "gold" : "ink"}
          />
          <Stat
            width={300}
            value={String(waiting.toShip)}
            label="a enviar"
            tone={waiting.toShip > 0 ? "gold" : "ink"}
          />
        </Section>
        {waiting.mustShipToday > 0 ? (
          <div style={{ marginTop: 10, fontSize: 22, color: C.claret600 }}>
            {`${waiting.mustShipToday} ${plural(waiting.mustShipToday, "pedido com data marcada precisa", "pedidos com data marcada precisam")} sair hoje`}
          </div>
        ) : null}
        {waiting.conversationsAwaitingOwner > 0 ? (
          <div style={{ marginTop: 10, fontSize: 22, color: C.claret600 }}>
            {`${waiting.conversationsAwaitingOwner} ${plural(waiting.conversationsAwaitingOwner, "conversa espera", "conversas esperam")} a sua resposta no WhatsApp`}
          </div>
        ) : null}

        <Section title="O QUE A LIA FEZ ONTEM">
          <Stat width={230} value={String(bot.conversations)} label="conversas" />
          <Stat width={230} value={String(bot.turns)} label="respostas" />
          <Stat width={230} value={String(bot.handoffs)} label="passou a você" />
          <Stat
            width={246}
            value={String(bot.orders)}
            label={bot.orders > 0 ? `pedidos · ${formatCentsBRL(bot.ordersCents)}` : "pedidos"}
            tone={bot.orders > 0 ? "laurel" : "ink"}
          />
        </Section>
        <div style={{ marginTop: 8, fontSize: 20, color: C.ink500 }}>
          {`Custo estimado da IA no dia: ${formatUsdCents(bot.costUsdCents)}`}
        </div>

        <Section title="ESTOQUE BAIXO">
          <div style={{ display: "flex", flexDirection: "column" }}>
            {data.lowStock.length === 0 ? (
              <span style={{ fontSize: 24, color: C.laurel700 }}>Tudo abastecido.</span>
            ) : (
              data.lowStock.map((row) => (
                <span
                  key={row.sku}
                  style={{ fontSize: 24, color: C.ink700, marginBottom: 6 }}
                >
                  {`${row.name.length > 44 ? `${row.name.slice(0, 43)}…` : row.name} · ${row.sku} · ${row.available <= 0 ? "esgotada" : `${row.available} ${plural(row.available, "restante", "restantes")}`}`}
                </span>
              ))
            )}
          </div>
        </Section>

        <Section title="MAIS VENDIDA DA SEMANA">
          {data.bestSeller ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontFamily: SERIF,
                  fontWeight: 600,
                  fontSize: 34,
                  lineHeight: 1.1,
                  color: C.espresso900,
                }}
              >
                {data.bestSeller.name.length > 48
                  ? `${data.bestSeller.name.slice(0, 47)}…`
                  : data.bestSeller.name}
              </span>
              <span style={{ marginTop: 6, fontSize: 22, color: C.ink500 }}>
                {`${data.bestSeller.quantity} ${plural(data.bestSeller.quantity, "vendida", "vendidas")} · ${formatCentsBRL(data.bestSeller.revenueCents)}`}
              </span>
            </div>
          ) : (
            <span style={{ fontSize: 24, color: C.ink500 }}>Sem vendas nos últimos 7 dias.</span>
          )}
        </Section>

        <div style={{ display: "flex", flexGrow: 1 }} />

        {/* Assinatura */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 20,
            borderTop: `1px solid ${C.ivory300}`,
          }}
        >
          <span style={{ fontSize: 20, fontWeight: 500, letterSpacing: 4, color: C.ink900 }}>
            {data.storeName.toUpperCase()}
          </span>
          <span style={{ fontSize: 18, color: C.ink500 }}>
            {`Gerado às ${timeFmt.format(data.generatedAt)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** PNG 1080×1350 do resumo diário. Sem rede: fontes e lockup vêm de `assets`. */
export async function renderDailyDigestPng(
  data: DailyDigestData,
  assets: ReceiptAssets,
): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const response = new ImageResponse(<Digest data={data} lockup={lockup} />, {
    width: DIGEST_WIDTH,
    height: DIGEST_HEIGHT,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
