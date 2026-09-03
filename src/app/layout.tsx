import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// A mono quase não aparece (só trechos técnicos do admin): sem preload, para
// não disputar banda com a imagem LCP da vitrine.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

// A imagem de compartilhamento vem da convenção src/app/opengraph-image.png
// (+ .alt.txt), que emite og:image com tipo, largura e altura sozinha.
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://trivemaison.com.br",
  ),
  title: {
    default: "TRIVÉ — Maison Féminine",
    template: "%s | TRIVÉ",
  },
  description:
    "TRIVÉ — Maison Féminine. Peças escolhidas com calma, para a mulher que se veste de si. Envio para todo o Brasil.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
