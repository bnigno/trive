import { describe, expect, it } from "vitest";

import { storeManifest } from "@/core/pwa/manifests";
import { GET } from "@/app/manifest.webmanifest/route";

describe("manifest.webmanifest (loja)", () => {
  it("nome, idioma, ícones (any + maskable) e start_url na raiz", async () => {
    const value = storeManifest();
    expect(value).toMatchObject({ short_name: "TRIVÉ", lang: "pt-BR", start_url: "/", display: "minimal-ui" });
    expect(value.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(value.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    expect(await GET().json()).toEqual(value);
  });
});
