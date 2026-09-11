import type { MetadataRoute } from "next";

// "Adicionar à tela de início" no celular com o nome e o ícone da maison.
// display minimal-ui: o checkout redireciona ao Mercado Pago e a barra do
// navegador precisa continuar visível.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TRIVÉ — Maison Féminine",
    short_name: "TRIVÉ",
    description: "Peças escolhidas com calma, para a mulher que se veste de si.",
    start_url: "/",
    display: "minimal-ui",
    lang: "pt-BR",
    background_color: "#FAF7F0",
    theme_color: "#FAF7F0",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
