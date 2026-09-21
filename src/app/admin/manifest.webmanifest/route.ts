// Manifest do PAINEL (o da loja, em /manifest.webmanifest, abre a vitrine
// em minimal-ui). Aqui é o app do dono: standalone e preso a /admin — no
// iPhone o aviso com o app fechado só existe assim, adicionado à tela de
// início. Formato definido em core/notify/manifest.ts para o teste conferir.
import { adminManifest } from "@/core/notify/manifest";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(adminManifest(), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" },
  });
}
