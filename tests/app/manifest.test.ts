import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";

describe("manifest.webmanifest", () => {
  it("nome, idioma, ícones (any + maskable) e start_url na raiz", () => {
    const value = manifest();
    expect(value).toMatchObject({ short_name: "TRIVÉ", lang: "pt-BR", start_url: "/", display: "minimal-ui" });
    const icons = value.icons ?? [];
    expect(icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  });
});
