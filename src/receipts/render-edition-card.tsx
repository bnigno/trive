// O cartão da edição que vai na caixa, um por peça (1080×1440 ≈ 9×12 cm a
// 300 dpi): papel marfim com moldura hairline e filete dourado, a faixa da
// edição em dourado, o nome da peça em Cormorant itálico, a frase da curadora
// entre aspas, dois quadros pequenos ("Como veste" / "Como vestir em Belém" e
// "Cuidados na umidade") e, embaixo, o QR para a página da peça ao lado da
// faixa noir com o lockup. Apresentação pura: EditionCardData + assets → PNG.
// Satori: só flexbox, todo <div> com mais de um filho declara display:flex,
// sem rede. Os corpos são para 9 cm de largura: 1 px = 0,083 mm impresso,
// então 26 px ≈ 6 pt — o mínimo que se lê a um palmo.
import { ImageResponse } from "next/og";

import { postEyebrow } from "@/core/cards/post";
import type { EditionCardData } from "@/core/edition/types";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

import { qrPngDataUrl } from "./qr";

export const EDITION_CARD_WIDTH = 1080;
export const EDITION_CARD_HEIGHT = 1440;

/** Corpos em px na imagem (× 0,083 = mm no papel de 9 cm). */
export const EDITION_TYPE = {
  eyebrow: 26,
  label: 26,
  body: 30,
  quoteMin: 34,
  quoteMax: 44,
  byline: 24,
  invite: 32,
  address: 30,
  /** ~1,8 cm impresso: lê no celular sem aproximar demais. */
  qr: 220,
  lockupWidth: 220,
  lockupHeight: 98,
} as const;

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
  if (note.length <= 70) return EDITION_TYPE.quoteMax;
  if (note.length <= 130) return 38;
  if (note.length <= 220) return 36;
  return EDITION_TYPE.quoteMin;
}

function Section({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          fontFamily: SANS,
          fontSize: EDITION_TYPE.label,
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
          fontSize: EDITION_TYPE.body,
          lineHeight: 1.4,
          color: C.ink700,
          // Uma palavra sem espaço (arroba, hashtag) quebra em vez de atravessar a moldura.
          wordBreak: "break-word",
        }}
      >
        {normalizeReceiptText(text)}
      </div>
    </div>
  );
}

function EditionCard({ data, lockup, qr }: { data: EditionCardData; lockup: string; qr: string }) {
  const name = normalizeReceiptText(data.productName);
  const quote = data.curatorNote ? normalizeReceiptText(data.curatorNote) : null;
  const wearLabel = data.wearSource === "ficha" ? "COMO VESTE" : "COMO VESTIR EM BELÉM";

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
        // A linha de corte: no papel branco, o marfim some — esta borda diz onde cortar.
        border: `1px solid ${C.ivory300}`,
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
            border: `2px solid ${C.gold400}`,
            padding: "40px 56px 0",
          }}
        >
          {/* Faixa da edição */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              fontSize: EDITION_TYPE.eyebrow,
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
              marginTop: 22,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: editionTitleFontSize(name),
              lineHeight: 1.08,
              color: C.ink900,
              wordBreak: "break-word",
            }}
          >
            {name}
          </div>

          {/* Filete curto */}
          <div style={{ display: "flex", justifyContent: "center", marginTop: 22 }}>
            <div style={{ display: "flex", width: 72, height: 2, backgroundColor: C.gold400 }} />
          </div>

          {/* A frase da curadora (quando existe) */}
          {quote ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                marginTop: 26,
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
                  wordBreak: "break-word",
                }}
              >
                {`“${quote}”`}
              </div>
              <div
                style={{
                  display: "flex",
                  fontFamily: SANS,
                  fontSize: EDITION_TYPE.byline,
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
              gap: 36,
              marginTop: quote ? 20 : 32,
              paddingBottom: 20,
              flexGrow: 1,
            }}
          >
            <Section label={wearLabel} text={data.wearNote} />
            <Section label="CUIDADOS NA UMIDADE" text={data.careNote} />
          </div>

          {/* Rodapé: QR + convite, e a faixa noir */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              paddingBottom: 24,
            }}
          >
            <img src={qr} width={EDITION_TYPE.qr} height={EDITION_TYPE.qr} alt="" />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flexShrink: 1 }}>
              <div
                style={{
                  display: "flex",
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: EDITION_TYPE.invite,
                  lineHeight: 1.2,
                  color: C.ink900,
                  wordBreak: "break-word",
                }}
              >
                Veja a peça, a ficha e a nossa conversa.
              </div>
              <div
                style={{
                  display: "flex",
                  fontFamily: SANS,
                  fontSize: EDITION_TYPE.address,
                  color: C.ink500,
                  wordBreak: "break-all",
                }}
              >
                {normalizeReceiptText(data.printedAddress)}
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 -56px",
              backgroundColor: C.noir950,
              padding: "16px 0",
            }}
          >
            <img src={lockup} width={EDITION_TYPE.lockupWidth} height={EDITION_TYPE.lockupHeight} alt="" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** PNG 1080×1440 do cartão. Sem rede: fontes, lockup e QR vêm de dentro. */
export async function renderEditionCardPng(data: EditionCardData, assets: ReceiptAssets): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const qr = await qrPngDataUrl(data.qrUrl, EDITION_TYPE.qr);
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
