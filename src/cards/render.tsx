// O cartão editorial da vendedora (1080×1350): faixa noir com o lockup e o
// eyebrow dourado, título em itálico e as fotos das peças em molduras com
// nome e preço — a vitrine da maison dentro do WhatsApp. Apresentação pura:
// recebe CardData (fotos já em data: URL) e os assets, devolve o PNG.
// Satori (next/og): só flexbox, todo <div> com mais de um filho declara
// display:flex, texto misto é UMA string, nada de rede.
import { ImageResponse } from "next/og";

import { cardFrameSize, type CardData, type CardItem } from "@/core/cards/types";
import { normalizeReceiptText, type ReceiptAssets } from "@/core/receipts/types";

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const C = {
  ivory100: "#faf7f0",
  ivory300: "#e7dfcc",
  ink900: "#201d18",
  ink700: "#453f35",
  ink500: "#6e6656",
  gold400: "#d4b96a",
  gold800: "#6f561b",
  noir950: "#0b0a09",
  white: "#ffffff",
};

const SERIF = "Cormorant Garamond";
const SANS = "Jost";

function clampName(name: string, max: number): string {
  const clean = normalizeReceiptText(name);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function Frame({
  item,
  width,
  height,
  nameSize,
  priceSize,
}: {
  item: CardItem;
  width: number;
  height: number;
  nameSize: number;
  priceSize: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width }}>
      <div
        style={{
          display: "flex",
          padding: 8,
          backgroundColor: C.white,
          border: `1px solid ${C.ivory300}`,
        }}
      >
        <img src={item.imageDataUrl} width={width - 18} height={height - 18} alt="" />
      </div>
      <div
        style={{
          marginTop: 16,
          fontFamily: SERIF,
          fontWeight: 600,
          fontSize: nameSize,
          lineHeight: 1.1,
          color: C.ink900,
          textAlign: "center",
        }}
      >
        {clampName(item.name, width >= 500 ? 40 : 26)}
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: SANS,
          fontWeight: 500,
          fontSize: priceSize,
          letterSpacing: 1.5,
          color: C.gold800,
        }}
      >
        {item.priceLabel}
      </div>
    </div>
  );
}

function Band({ lockup, eyebrow }: { lockup: string; eyebrow: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.noir950,
        padding: "32px 72px 28px",
      }}
    >
      <img src={lockup} width={300} height={133} alt="" />
      <div
        style={{
          marginTop: 12,
          fontFamily: SANS,
          fontSize: 18,
          fontWeight: 500,
          letterSpacing: 6,
          color: C.gold400,
        }}
      >
        {normalizeReceiptText(eyebrow).toUpperCase()}
      </div>
    </div>
  );
}

function Title({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        fontFamily: SERIF,
        fontStyle: "italic",
        fontSize: 46,
        color: C.ink900,
        textAlign: "center",
      }}
    >
      {clampName(text, 44)}
    </div>
  );
}

function Footer({ storeName }: { storeName: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "0 72px 40px",
      }}
    >
      <div style={{ width: 120, height: 1, backgroundColor: C.gold400 }} />
      <div
        style={{
          marginTop: 16,
          fontFamily: SANS,
          fontSize: 18,
          letterSpacing: 5,
          color: C.ink700,
        }}
      >
        {normalizeReceiptText(storeName).toUpperCase()}
      </div>
      <div style={{ marginTop: 6, fontFamily: SANS, fontSize: 18, color: C.ink500 }}>
        Responda com o nome da peça que quer ver de perto.
      </div>
    </div>
  );
}

function Card({ data, lockup }: { data: CardData; lockup: string }) {
  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.ivory100,
        color: C.ink900,
        fontFamily: SANS,
      }}
    >
      <Band lockup={lockup} eyebrow={data.eyebrow} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flexGrow: 1,
          gap: 36,
          padding: "24px 0",
        }}
      >
      <Title text={data.title} />
      {data.kind === "catalog" ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            gap: data.items.length >= 3 ? 30 : 40,
            padding: "0 40px",
          }}
        >
          {data.items.map((item) => {
            const size = cardFrameSize("catalog", "item", data.items.length);
            return (
              <Frame
                key={item.slug}
                item={item}
                width={size.width}
                height={size.height}
                nameSize={data.items.length >= 3 ? 28 : 34}
                priceSize={data.items.length >= 3 ? 20 : 24}
              />
            );
          })}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            gap: 40,
            padding: "0 40px",
          }}
        >
          <Frame
            item={data.hero}
            width={cardFrameSize("look", "hero", 1).width}
            height={cardFrameSize("look", "hero", 1).height}
            nameSize={34}
            priceSize={24}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {data.complements.map((item) => (
              <Frame
                key={item.slug}
                item={item}
                width={cardFrameSize("look", "complement", 1).width}
                height={cardFrameSize("look", "complement", 1).height}
                nameSize={24}
                priceSize={19}
              />
            ))}
          </div>
        </div>
      )}
      </div>
      <Footer storeName={data.storeName} />
    </div>
  );
}

/** PNG 1080×1350 do cartão. Sem rede: fontes, lockup e fotos vêm embutidos. */
export async function renderCardPng(data: CardData, assets: ReceiptAssets): Promise<Buffer> {
  const lockup = `data:image/png;base64,${assets.lockupDarkPng.toString("base64")}`;
  const response = new ImageResponse(<Card data={data} lockup={lockup} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });
  return Buffer.from(await response.arrayBuffer());
}
