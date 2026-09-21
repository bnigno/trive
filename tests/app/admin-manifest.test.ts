// O manifest do painel: app instalável preso a /admin (é o que o iPhone exige para o Web Push).
import { describe, expect, it } from "vitest";

import { adminManifest } from "@/core/notify/manifest";
import { GET } from "@/app/admin/manifest.webmanifest/route";

describe("manifest do painel", () => {
  it("standalone, começa e fica em /admin, com os ícones da marca", async () => {
    const manifest = adminManifest();
    expect(manifest).toMatchObject({ name: "TRIVÉ Painel", start_url: "/admin", scope: "/admin", display: "standalone", lang: "pt-BR" });
    expect(manifest.icons.map((icon) => icon.src)).toEqual(["/brand/icon-192.png", "/brand/icon-512.png", "/brand/icon-512-maskable.png"]);
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);

    const response = GET();
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(await response.json()).toEqual(manifest);
  });
});
