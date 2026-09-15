// Arquivo para gráfica: uma página por lado, 61 × 96 mm (a tag de 55 × 90
// mais 3 mm de sangria de cada lado), tag centrada, marcas de corte na faixa
// de sangria e uma linha de identificação que some no corte. Um par
// frente/verso por modelo (variação); a gráfica imprime a quantidade.
import { Fragment, type ReactNode } from "react";

import type { LabelDesign } from "@/core/catalog/labels";

import { HangTagBack, HangTagFront, SANS, TAG, TAG_INK } from "./hang-tag";

export const PRESS_PAGE = {
  widthMm: TAG.widthMm + 2 * TAG.bleedMm,
  heightMm: TAG.heightMm + 2 * TAG.bleedMm,
} as const;

function PressPage({ children, slug }: { children: ReactNode; slug: string }) {
  return (
    <section
      className="print-page press-page w-fit shrink-0 shadow-md"
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: `${PRESS_PAGE.widthMm}mm`,
        height: `${PRESS_PAGE.heightMm}mm`,
        padding: `${TAG.bleedMm}mm`,
        background: TAG_INK.paper,
      }}
    >
      {children}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: "0.7mm",
          textAlign: "center",
          fontFamily: SANS,
          fontSize: "4pt",
          letterSpacing: "0.06em",
          color: TAG_INK.taupe,
        }}
      >
        {slug}
      </div>
    </section>
  );
}

export function HangTagPress({ designs, storeName }: { designs: readonly LabelDesign[]; storeName: string }) {
  return (
    <>
      {designs.map((design) => (
        <Fragment key={design.key}>
          <PressPage slug={`${design.sku} · frente · ${design.quantity} un.`}>
            <HangTagFront storeName={storeName} crop />
          </PressPage>
          <PressPage slug={`${design.sku} · verso · ${design.quantity} un.`}>
            <HangTagBack label={design} crop />
          </PressPage>
        </Fragment>
      ))}
    </>
  );
}
