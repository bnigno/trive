// O vale de papel (1080×720 ≈ 15×10 cm), irmão da carta de estreia: papel
// marfim com moldura hairline e filete dourado, a faixa "VALE 10% · PARA
// VOCÊ", o código grande, o convite em Cormorant itálico, o QR do WhatsApp
// da Lia e a faixa noir com o lockup. Apresentação pura: VoucherCardData +
// assets → PNG. Satori: só flexbox, todo <div> com mais de um filho declara
// display:flex, sem rede (o QR é desenhado aqui).
import { ImageResponse } from "next/og";

import { EDITION_PAPER } from "@/core/edition/layout";
import { postEyebrow } from "@/core/cards/post";
import { voucherTexts, type VoucherCardData } from "@/core/edition/voucher";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

import { qrPngDataUrl } from "./qr";

export const VOUCHER_WIDTH = 1080;
export const VOUCHER_HEIGHT = 720;
const QR_SIZE = 200;

const C = {
  ivory50: EDITION_PAPER,
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  ink500: "#6b6357",
  gold400: "#d4b96a",
  gold800: "#6f561b",
  noir950: "#0b0a09",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

function Voucher({ data, lockup, qr }: { data: VoucherCardData; lockup: string; qr: string }) {
  const texts = voucherTexts(data);
  return (
    <div
      style={{
        width: VOUCHER_WIDTH,
        height: VOUCHER_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory50,
        color: C.ink900,
        fontFamily: SANS,
        padding: 28,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, border: `1px solid ${C.ivory300}`, padding: 6 }}>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, border: `1px solid ${C.gold400}`, padding: "28px 56px 0" }}>
          {/* Faixa da edição e o vale */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <div style={{ display: "flex", fontSize: 14, lineHeight: 1.2, letterSpacing: 5, color: C.gold800, whiteSpace: "nowrap" }}>
              {normalizeReceiptText(postEyebrow(data.editionName))}
            </div>
            <div style={{ display: "flex", fontSize: 20, lineHeight: 1.2, fontWeight: 500, letterSpacing: 6, color: C.gold800, whiteSpace: "nowrap" }}>
              {normalizeReceiptText(texts.eyebrow)}
            </div>
          </div>

          {/* O miolo: texto à esquerda, QR à direita */}
          <div style={{ display: "flex", flexGrow: 1, minHeight: 0, alignItems: "center", justifyContent: "space-between", padding: "18px 0 14px" }}>
            {/* Largura fixa: um texto longo quebra em linhas em vez de empurrar o QR para fora. */}
            <div style={{ display: "flex", flexDirection: "column", width: 640, flexShrink: 0, gap: 14 }}>
              <div style={{ display: "flex", fontFamily: SERIF, fontSize: 44, lineHeight: 1.1, color: C.ink900 }}>
                {normalizeReceiptText(texts.headline)}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 52,
                  lineHeight: 1.1,
                  fontWeight: 500,
                  letterSpacing: 6,
                  color: C.ink900,
                  whiteSpace: "nowrap",
                }}
              >
                {data.code}
              </div>
              <div style={{ display: "flex", fontFamily: SERIF, fontStyle: "italic", fontSize: 27, lineHeight: 1.25, color: C.ink700, wordBreak: "break-word" }}>
                {normalizeReceiptText(texts.body)}
              </div>
              <div style={{ display: "flex", fontSize: 17, lineHeight: 1.3, color: C.ink500 }}>{normalizeReceiptText(texts.invite)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: QR_SIZE + 20, flexShrink: 0 }}>
              <img src={qr} width={QR_SIZE} height={QR_SIZE} alt="" />
              <div style={{ display: "flex", fontSize: 13, letterSpacing: 3, color: C.gold800, whiteSpace: "nowrap" }}>WHATSAPP</div>
            </div>
          </div>

          {/* Faixa noir estreita com o lockup */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", margin: "0 -56px", backgroundColor: C.noir950, padding: "14px 0", flexShrink: 0 }}>
            <img src={lockup} width={150} height={67} alt="" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** PNG 1080×720 do vale. Sem rede: fontes, lockup e QR vêm daqui. */
export async function renderVoucherPng(data: VoucherCardData, assets: ReceiptAssets): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const qr = await qrPngDataUrl(data.qrUrl, QR_SIZE);
  const response = new ImageResponse(<Voucher data={data} lockup={lockup} qr={qr} />, {
    width: VOUCHER_WIDTH,
    height: VOUCHER_HEIGHT,
    fonts: assets.fonts.map((font) => ({ name: font.name, data: font.data, weight: font.weight, style: font.style })),
  });
  return Buffer.from(await response.arrayBuffer());
}
