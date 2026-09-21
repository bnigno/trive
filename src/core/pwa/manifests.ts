// Os dois manifests como dado puro (as rotas só serializam; os testes conferem).
// Loja: "Adicionar à tela de início" abre a vitrine em minimal-ui (o checkout
// redireciona ao Mercado Pago e a barra do navegador precisa continuar).
// Painel: app standalone preso a /admin — no iPhone o aviso com o app fechado
// (Web Push) só existe assim, adicionado à tela de início.
export const ADMIN_THEME_COLOR = "#0b0a09";

const ICONS = [
  { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" as const },
  { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" as const },
  { src: "/brand/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" as const },
];

export function storeManifest() {
  return {
    name: "TRIVÉ — Maison Féminine",
    short_name: "TRIVÉ",
    description: "Peças escolhidas com calma, para a mulher que se veste de si.",
    start_url: "/",
    display: "minimal-ui" as const,
    lang: "pt-BR",
    background_color: "#FAF7F0",
    theme_color: "#FAF7F0",
    icons: ICONS,
  };
}

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
    icons: ICONS,
  };
}
