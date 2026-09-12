// Layout mínimo da página-cortina dos links de story (/ig/[slug]): só as
// fontes da maison sobre noir — sem header, rodapé ou sacola, porque a
// cliente passa por aqui por um instante a caminho do WhatsApp.
import type { Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#0b0a09",
  viewportFit: "cover",
};

export default function IgLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-store=""
      className={`${cormorant.variable} ${jost.variable} flex min-h-screen flex-col bg-noir-950 font-store text-ivory-100`}
    >
      {children}
    </div>
  );
}
