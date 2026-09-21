// Só o <head> do painel (login incluído): o manifest do app instalável e as
// tags do iPhone. O layout protegido, logo abaixo, continua cuidando do resto.
import type { Metadata, Viewport } from "next";

import { ADMIN_THEME_COLOR } from "@/core/notify/manifest";

export const metadata: Metadata = {
  manifest: "/admin/manifest.webmanifest",
  appleWebApp: { capable: true, title: "TRIVÉ Painel", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: ADMIN_THEME_COLOR,
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
