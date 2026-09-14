// O cartão da edição que vai na caixa, um por peça (1080×1440 ≈ 9×12 cm a
// 300 dpi): papel marfim com moldura hairline e filete dourado, a faixa da
// edição em dourado, o nome da peça em Cormorant itálico, a frase da curadora
// entre aspas, dois quadros pequenos ("Como veste" / "Como vestir em Belém" e
// "Cuidados na umidade") e, embaixo, o QR para a página da peça ao lado da
// faixa noir com o lockup. Apresentação pura: EditionCardData + assets → PNG.
// Satori: só flexbox, todo <div> com mais de um filho declara display:flex,
// flexShrink é 0 por padrão, sem rede. A geometria e os corpos vêm do core
// (core/edition/layout.ts fecha o orçamento de altura); aqui cada bloco de
// texto ainda ganha uma trava na fronteira da última linha permitida — se a
// estimativa errar por uma linha, some a linha inteira, nunca meia.
import { ImageResponse } from "next/og";

import { postEyebrow } from "@/core/cards/post";
import { EDITION_GEOMETRY as G } from "@/core/edition/layout";
import { editionInvite } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

import { qrPngDataUrl } from "./qr";

export const EDITION_CARD_WIDTH = G.width;
export const EDITION_CARD_HEIGHT = G.height;

/** Corpos em px na imagem (× 0,083 = mm no papel de 9 cm); os elásticos vêm do layout. */
export const EDITION_TYPE = {
  eyebrow: G.eyebrow.size,
  /** Nome de edição longo: corpo e espaçamento menores para caber numa linha (24 px ≈ 5,7 pt). */
  eyebrowTight: 24,
  label: G.label.size,
  body: G.body.sizes[0],
  bodyMin: G.body.sizes[G.body.sizes.length - 1],
  quoteMin: G.quote.sizes[G.quote.sizes.length - 1],
  quoteMax: G.quote.sizes[0],
  byline: G.byline.size,
  invite: 32,
  address: 30,
  qrMin: 220,
  qrMax: 300,
  lockupWidth: 220,
  lockupHeight: G.band.lockupHeight,
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

/** A faixa da edição numa linha só: acima de ~30 caracteres, corpo 24 e espaçamento 4. */
export function eyebrowStyle(text: string): { fontSize: number; letterSpacing: number } {
  return text.length > 30 ? { fontSize: EDITION_TYPE.eyebrowTight, letterSpacing: 4 } : { fontSize: EDITION_TYPE.eyebrow, letterSpacing: 7 };
}

function Section({ label, text, fontSize, lines }: { label: string; text: string; fontSize: number; lines: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: G.label.gap, flexShrink: 0 }}>
      <div
        style={{
          display: "flex",
          fontFamily: SANS,
          fontSize: G.label.size,
          lineHeight: G.label.lineHeight,
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
          fontSize,
          lineHeight: G.body.lineHeight,
          color: C.ink700,
          // Uma palavra sem espaço (arroba, hashtag) quebra em vez de atravessar a moldura.
          wordBreak: "break-word",
          // A trava: as linhas que o orçamento assumiu, inteiras; a seguinte some por inteiro.
          maxHeight: Math.round(lines * G.body.lineHeight * fontSize),
          overflow: "hidden",
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
  const eyebrow = normalizeReceiptText(postEyebrow(data.editionName));
  const { titleSize, titleLines, quoteSize, quoteLines, bodySize, wearLines, careLines, qrSize } = data.layout;

  return (
    <div
      style={{
        width: G.width,
        height: G.height,
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
      {/* Moldura: hairline marfim com filete dourado por dentro (flexShrink 1 para nunca crescer com o texto) */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          border: `1px solid ${C.ivory300}`,
          padding: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
            border: `2px solid ${C.gold400}`,
            padding: "40px 56px 0",
          }}
        >
          {/* Faixa da edição: uma linha, centrada */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              lineHeight: G.eyebrow.lineHeight,
              fontWeight: 500,
              color: C.gold800,
              ...eyebrowStyle(eyebrow),
            }}
          >
            {eyebrow}
          </div>

          {/* Nome da peça: até duas linhas inteiras */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              textAlign: "center",
              marginTop: G.title.marginTop,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: titleSize,
              lineHeight: G.title.lineHeight,
              color: C.ink900,
              wordBreak: "break-word",
              maxHeight: Math.round(titleLines * G.title.lineHeight * titleSize),
              overflow: "hidden",
            }}
          >
            {name}
          </div>

          {/* Filete curto */}
          <div style={{ display: "flex", justifyContent: "center", marginTop: G.rule.marginTop }}>
            <div style={{ display: "flex", width: 72, height: G.rule.height, backgroundColor: C.gold400 }} />
          </div>

          {/* A frase da curadora (quando existe): até cinco linhas inteiras */}
          {quote ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                marginTop: G.quote.marginTop,
                gap: G.quote.gap,
              }}
            >
              <div
                style={{
                  display: "flex",
                  textAlign: "center",
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: quoteSize,
                  lineHeight: G.quote.lineHeight,
                  color: C.ink900,
                  wordBreak: "break-word",
                  maxHeight: Math.round(quoteLines * G.quote.lineHeight * quoteSize),
                  overflow: "hidden",
                }}
              >
                {`“${quote}”`}
              </div>
              <div
                style={{
                  display: "flex",
                  fontFamily: SANS,
                  fontSize: G.byline.size,
                  lineHeight: G.byline.lineHeight,
                  letterSpacing: 4,
                  color: C.ink500,
                }}
              >
                A CURADORA
              </div>
            </div>
          ) : null}

          {/*
            Os dois quadros: no meio do que sobra (os dois espaçadores dividem
            a folga), para o cartão não ficar oco. Se mesmo assim algo passar,
            é este bloco que encolhe e corta embaixo — o QR e a faixa noir
            nunca saem do cartão.
          */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: quote ? G.boxes.marginTopWithQuote : G.boxes.marginTopAlone,
              paddingBottom: G.boxes.paddingBottom,
              flexGrow: 1,
              flexShrink: 1,
              minHeight: 0,
            }}
          >
            <div style={{ display: "flex", flexGrow: 1, flexShrink: 1, minHeight: 0 }} />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: G.boxes.gap,
                flexShrink: 1,
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              <Section label={wearLabel} text={data.wearNote} fontSize={bodySize} lines={wearLines} />
              <Section label="CUIDADOS NA UMIDADE" text={data.careNote} fontSize={bodySize} lines={careLines} />
            </div>
            <div style={{ display: "flex", flexGrow: 1, flexShrink: 1, minHeight: 0 }} />
          </div>

          {/* Rodapé: QR + convite, e a faixa noir */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              paddingBottom: G.footer.paddingBottom,
              flexShrink: 0,
            }}
          >
            <img src={qr} width={qrSize} height={qrSize} alt="" />
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
                {editionInvite(data.qrTarget, data.storeName)}
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
              padding: `${G.band.padding}px 0`,
              flexShrink: 0,
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
  const qr = await qrPngDataUrl(data.qrUrl, data.layout.qrSize);
  const response = new ImageResponse(<EditionCard data={data} lockup={lockup} qr={qr} />, {
    width: G.width,
    height: G.height,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
