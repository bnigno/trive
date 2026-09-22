// Manifest do PAINEL (o da loja fica em /manifest.webmanifest). O layout do
// admin aponta para cá em metadata.manifest; formato em core/pwa/manifests.ts.
import { adminManifest } from "@/core/pwa/manifests";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(adminManifest(), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" },
  });
}
