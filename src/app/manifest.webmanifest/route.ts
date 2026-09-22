// Manifest da LOJA. Era o arquivo-convenção src/app/manifest.ts, mas ele vale
// para o site inteiro e passava por cima do manifest do painel; como rota, o
// layout de cada área aponta para o seu (metadata.manifest).
import { storeManifest } from "@/core/pwa/manifests";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(storeManifest(), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" },
  });
}
