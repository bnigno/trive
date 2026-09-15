// Layout mínimo da página do motoboy (/entrega/[token]): claro, sem header
// nem sacola — ele lê isso no sol, no guidão, com o dedão. Só as fontes da
// loja e o fundo marfim.
import type { Viewport } from "next";
import { Jost } from "next/font/google";

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#FAF7F0",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function EntregaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-store="" className={`${jost.variable} flex min-h-screen flex-col bg-ivory-100 font-store text-ink-900`}>
      {children}
    </div>
  );
}
