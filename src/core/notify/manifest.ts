// O manifest do painel como dado puro (a rota só serializa; o teste confere).
export const ADMIN_THEME_COLOR = "#0b0a09";

export function adminManifest() {
  return {
    name: "TRIVÉ Painel",
    short_name: "Painel",
    description: "O painel da TRIVÉ: pedidos, WhatsApp e a vendedora Lia.",
    start_url: "/admin",
    scope: "/admin",
    display: "standalone" as const,
    lang: "pt-BR",
    background_color: ADMIN_THEME_COLOR,
    theme_color: ADMIN_THEME_COLOR,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
