// O bilhete do presente (1080×720 ≈ 15×10 cm): papel marfim com moldura
// hairline e filete dourado, "PARA {NOME}" em dourado, a mensagem em
// Cormorant itálico centralizada, a assinatura e uma faixa noir estreita
// com o lockup. Apresentação pura: GiftNoteData + assets → PNG. Satori: só
// flexbox, todo <div> com mais de um filho declara display:flex, sem rede.
import { ImageResponse } from "next/og";

import { EDITION_PAPER } from "@/core/edition/layout";
import { giftMessageFontSize } from "@/core/gifts/text";
import type { GiftNoteData } from "@/core/gifts/types";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

export const GIFT_NOTE_WIDTH = 1080;
export const GIFT_NOTE_HEIGHT = 720;

const C = {
  ivory50: EDITION_PAPER,
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  gold400: "#d4b96a",
  gold800: "#6f561b",
  noir950: "#0b0a09",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

function GiftNote({ data, lockup }: { data: GiftNoteData; lockup: string }) {
  const message = data.message ?? "";
  const lines = message === "" ? [] : message.split("\n");
  const fontSize = giftMessageFontSize(message);

  return (
    <div
      style={{
        width: GIFT_NOTE_WIDTH,
        height: GIFT_NOTE_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory50,
        color: C.ink900,
        fontFamily: SANS,
        padding: 28,
      }}
    >
      {/* Moldura: hairline marfim com filete dourado por dentro */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          border: `1px solid ${C.ivory300}`,
          padding: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            border: `1px solid ${C.gold400}`,
            padding: "36px 64px 0",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 500,
              letterSpacing: 6,
              color: C.gold800,
            }}
          >
            {`PARA ${normalizeReceiptText(data.recipientName).toUpperCase()}`}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flexGrow: 1,
              gap: 4,
              padding: "12px 0",
            }}
          >
            {lines.length > 0 ? (
              lines.map((line, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    fontFamily: SERIF,
                    fontStyle: "italic",
                    fontSize,
                    lineHeight: 1.25,
                    color: C.ink900,
                    textAlign: "center",
                    minHeight: fontSize * 0.6,
                  }}
                >
                  {line === "" ? " " : line}
                </div>
              ))
            ) : (
              <div
                style={{
                  display: "flex",
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: 40,
                  color: C.ink700,
                }}
              >
                Um presente escolhido com carinho.
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              paddingBottom: 26,
              fontFamily: SERIF,
              fontWeight: 600,
              fontSize: 30,
              color: C.ink700,
            }}
          >
            {normalizeReceiptText(data.signature)}
          </div>

          {/* Faixa noir estreita com o lockup */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 18,
              margin: "0 -64px",
              backgroundColor: C.noir950,
              padding: "14px 0",
            }}
          >
            <img src={lockup} width={150} height={67} alt="" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** PNG 1080×720 do bilhete. Sem rede: fontes e lockup vêm de `assets`. */
export async function renderGiftNotePng(data: GiftNoteData, assets: ReceiptAssets): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const response = new ImageResponse(<GiftNote data={data} lockup={lockup} />, {
    width: GIFT_NOTE_WIDTH,
    height: GIFT_NOTE_HEIGHT,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
