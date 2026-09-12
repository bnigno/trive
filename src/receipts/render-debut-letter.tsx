// A carta de estreia (1080×720 ≈ 15×10 cm), irmã do bilhete do presente:
// papel marfim com moldura hairline e filete dourado, "PARA {NOME}" em
// dourado, o texto da dona em Cormorant itálico, a assinatura e a faixa noir
// com o lockup. Apresentação pura: DebutLetterData + assets → PNG. Satori:
// só flexbox, todo <div> com mais de um filho declara display:flex, sem rede.
import { ImageResponse } from "next/og";

import { postEyebrow } from "@/core/cards/post";
import { DEBUT_LETTER_GEOMETRY as L, debutLetterLayout } from "@/core/edition/debut";
import type { DebutLetterData } from "@/core/edition/types";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

export const DEBUT_LETTER_WIDTH = L.width;
export const DEBUT_LETTER_HEIGHT = L.height;

const C = {
  ivory50: "#fdfbf6",
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  gold400: "#d4b96a",
  gold800: "#6f561b",
  noir950: "#0b0a09",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

function DebutLetter({ data, lockup }: { data: DebutLetterData; lockup: string }) {
  const lines = data.text.split("\n");
  // O corpo vem do orçamento do papel (core): a carta cabe por construção;
  // se um texto antigo não couber nem no menor corpo, o bloco corta embaixo
  // e a assinatura e a faixa noir ficam no lugar.
  const { fontSize } = debutLetterLayout(data.text);

  return (
    <div
      style={{
        width: DEBUT_LETTER_WIDTH,
        height: DEBUT_LETTER_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory50,
        color: C.ink900,
        fontFamily: SANS,
        padding: 28,
      }}
    >
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
            border: `1px solid ${C.gold400}`,
            padding: "30px 64px 0",
          }}
        >
          {/* Faixa da edição e "PARA {NOME}" */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", fontSize: 15, lineHeight: 1.2, letterSpacing: 5, color: C.gold800, whiteSpace: "nowrap" }}>
              {normalizeReceiptText(postEyebrow(data.editionName))}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 20,
                lineHeight: 1.2,
                fontWeight: 500,
                letterSpacing: 6,
                color: C.gold800,
                whiteSpace: "nowrap",
              }}
            >
              {`PARA ${normalizeReceiptText(data.recipientName).toUpperCase()}`}
            </div>
          </div>

          {/* A carta: no meio do que sobra; é o bloco que cede se algo não couber */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flexGrow: 1,
              flexShrink: 1,
              minHeight: 0,
              overflow: "hidden",
              padding: "10px 0",
            }}
          >
            {lines.map((line, index) =>
              line === "" ? (
                // Respiro entre parágrafos: menor que uma linha (o orçamento conta o mesmo).
                <div key={index} style={{ display: "flex", flexShrink: 0, height: fontSize * L.lineHeight * L.blankLine }} />
              ) : (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    flexShrink: 0,
                    fontFamily: SERIF,
                    fontStyle: "italic",
                    fontSize,
                    lineHeight: L.lineHeight,
                    color: C.ink900,
                    textAlign: "center",
                  }}
                >
                  {normalizeReceiptText(line)}
                </div>
              ),
            )}
          </div>

          {/* Assinatura: uma linha (o teto de largura do core garante) */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              paddingBottom: 22,
              fontFamily: SERIF,
              fontWeight: 600,
              fontSize: 28,
              lineHeight: 1.2,
              color: C.ink700,
              whiteSpace: "nowrap",
              flexShrink: 0,
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
              margin: "0 -64px",
              backgroundColor: C.noir950,
              padding: "14px 0",
              flexShrink: 0,
            }}
          >
            <img src={lockup} width={150} height={67} alt="" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** PNG 1080×720 da carta. Sem rede: fontes e lockup vêm de `assets`. */
export async function renderDebutLetterPng(data: DebutLetterData, assets: ReceiptAssets): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const response = new ImageResponse(<DebutLetter data={data} lockup={lockup} />, {
    width: DEBUT_LETTER_WIDTH,
    height: DEBUT_LETTER_HEIGHT,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
