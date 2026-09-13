// As silhuetas da estreia: a thumb (ou a foto cheia) vira um webp pequeno e
// desfocado em data URL; foto que não existe fica null sem derrubar as outras.
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { buildSilhouettes, SILHOUETTE_WIDTH } from "@/services/drop-teaser";

async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 80 } } }).webp().toBuffer();
}

describe("buildSilhouettes", () => {
  it("usa a thumb quando existe, cai na foto cheia, e devolve null para foto ausente", async () => {
    const storage = new FakeFileStorage();
    await storage.upload({ path: "a/1-thumb.webp", data: await photo(400, 500), contentType: "image/webp" });
    await storage.upload({ path: "b/1-full.webp", data: await photo(1600, 2000), contentType: "image/webp" });
    const [a, b, c, d] = await buildSilhouettes(storage, ["a/1-full.webp", "b/1-full.webp", "c/1-full.webp", null]);
    expect(a).toMatch(/^data:image\/webp;base64,/);
    expect(b).toMatch(/^data:image\/webp;base64,/);
    expect(c).toBeNull();
    expect(d).toBeNull();
    const meta = await sharp(Buffer.from((a as string).split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(SILHOUETTE_WIDTH);
    expect(meta.height).toBe(Math.round(SILHOUETTE_WIDTH * 1.25));
    // Pequena o bastante para ir embutida na página.
    expect((a as string).length).toBeLessThan(40_000);
  });
});
