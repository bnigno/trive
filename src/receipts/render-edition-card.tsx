// O cartão da edição que vai na caixa, um por peça (1080×1440 ≈ 9×12 cm a
// 300 dpi): papel marfim com moldura hairline e filete dourado, a faixa da
// edição em dourado, o nome da peça em Cormorant itálico, a frase da curadora
// entre aspas, dois quadros pequenos ("Como vestir em Belém", "Cuidados na
// umidade") e, embaixo, o QR para a página da peça ao lado da faixa noir com
// o lockup. Apresentação pura: EditionCardData + assets → PNG. Satori: só
// flexbox, todo <div> com mais de um filho declara display:flex, sem rede.
import { ImageResponse } from "next/og";

import { postEyebrow } from "@/core/cards/post";
import type { EditionCardData } from "@/core/edition/types";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

import { qrPngDataUrl } from "./qr";

export const EDITION_CARD_WIDTH = 1080;
export const EDITION_CARD_HEIGHT = 1440;
/** ~1,7 cm impresso: lê no celular sem aproximar demais. */
const QR_PRINT_SIZE = 200;

const C = {
  ivory50: "#fdfbf6",
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  ink500: "#6f6759",
  gold400: "#d4b96a",
  gold800: "#6f561b",
  noir950: "#0b0a09",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

/** Nome longo desce de corpo para caber em duas linhas. */
export function editionTitleFontSize(name: string): number {
  if (name.length <= 18) return 84;
  if (name.length <= 28) return 68;
  if (name.length <= 40) return 56;
  return 46;
}

/** A frase da curadora: quanto mais longa, menor. */
export function editionQuoteFontSize(note: string): number {
  if (note.length <= 70) return 40;
  if (note.length <= 130) return 34;
  return 30;
}

function Section({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          fontFamily: SANS,
          fontSize: 17,
          fontWeight: 500,
          letterSpacing: 4,
          color: C.gold800,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          fontFamily: SANS,
          fontSize: 29,
          lineHeight: 1.4,
          color: C.ink700,
        }}
      >
        {normalizeReceiptText(text.replace(/\n+/g, " "))}
      </div>
    </div>
  );
}

function EditionCard({ data, lockup, qr }: { data: EditionCardData; lockup: string; qr: string }) {
  const name = normalizeReceiptText(data.productName);
  const quote = data.curatorNote ? normalizeReceiptText(data.curatorNote.replace(/\n+/g, " ")) : null;

  return (
    <div
      style={{
        width: EDITION_CARD_WIDTH,
        height: EDITION_CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory50,
        color: C.ink900,
        fontFamily: SANS,
        padding: 30,
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
            padding: "44px 60px 0",
          }}
        >
          {/* Faixa da edição */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 500,
              letterSpacing: 7,
              color: C.gold800,
            }}
          >
            {normalizeReceiptText(postEyebrow(data.editionName))}
          </div>

          {/* Nome da peça */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              textAlign: "center",
              marginTop: 26,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontWeight: 500,
              fontSize: editionTitleFontSize(name),
              lineHeight: 1.08,
              color: C.ink900,
            }}
          >
            {name}
          </div>

          {/* Filete curto */}
          <div style={{ display: "flex", justifyContent: "center", marginTop: 26 }}>
            <div style={{ display: "flex", width: 72, height: 1, backgroundColor: C.gold400 }} />
          </div>

          {/* A frase da curadora (quando existe) */}
          {quote ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                marginTop: 30,
                gap: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  textAlign: "center",
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: editionQuoteFontSize(quote),
                  lineHeight: 1.28,
                  color: C.ink900,
                }}
              >
                {`“${quote}”`}
              </div>
              <div
                style={{
                  display: "flex",
                  fontFamily: SANS,
                  fontSize: 17,
                  letterSpacing: 4,
                  color: C.ink500,
                }}
              >
                A CURADORA
              </div>
            </div>
          ) : null}

          {/* Os dois quadros: no meio do que sobra, para o cartão não ficar oco */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 40,
              marginTop: quote ? 24 : 36,
              paddingBottom: 24,
              flexGrow: 1,
            }}
          >
            <Section label="COMO VESTIR EM BELÉM" text={data.wearNote} />
            <Section label="CUIDADOS NA UMIDADE" text={data.careNote} />
          </div>

          {/* Rodapé: QR + convite, e a faixa noir */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              paddingBottom: 26,
            }}
          >
            <img src={qr} width={QR_PRINT_SIZE} height={QR_PRINT_SIZE} alt="" />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  display: "flex",
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: 30,
                  color: C.ink900,
                }}
              >
                Veja a peça, a ficha e a nossa conversa.
              </div>
              <div style={{ display: "flex", fontFamily: SANS, fontSize: 19, color: C.ink500 }}>
                {normalizeReceiptText(data.productUrl.replace(/^https?:\/\//, ""))}
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 -60px",
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

/** PNG 1080×1440 do cartão. Sem rede: fontes, lockup e QR vêm de dentro. */
export async function renderEditionCardPng(data: EditionCardData, assets: ReceiptAssets): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const qr = await qrPngDataUrl(data.productUrl);
  const response = new ImageResponse(<EditionCard data={data} lockup={lockup} qr={qr} />, {
    width: EDITION_CARD_WIDTH,
    height: EDITION_CARD_HEIGHT,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
