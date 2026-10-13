// "Me vê com ela": a foto da cliente e a prévia NUNCA são guardadas — nem no
// Storage (o bucket product-images é público), nem nas fotos da peça, nem no
// "Quem já vestiu", nem como URL na conversa. Este teste varre o código da
// prévia atrás de qualquer caminho de gravação de imagem.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");
const TRYON_FILES = ["services/tryon.ts", "services/tryon-generate.ts", "services/tryon-settings.ts", "queue/handlers/tryon.ts"];

/** Grava imagem: sobe ao Storage, gera URL pública, escreve nas fotos da peça/looks ou manda por URL. */
export function storesImages(source: string): string[] {
  const found: string[] = [];
  if (/\.upload\(/.test(source)) found.push("storage.upload");
  if (/publicUrl\(/.test(source)) found.push("publicUrl");
  if (/\bproductImages\b|product_images/.test(source) && /insert\(\s*productImages/.test(source)) found.push("product_images");
  if (/\bcustomerLooks\b|customer_looks/.test(source)) found.push("customer_looks");
  // Mandar por URL exigiria a imagem num lugar público (é daí que a conversa grava media_url).
  if (/imageUrl\s*:/.test(source)) found.push("imageUrl");
  if (/set\(\{[^}]*mediaUrl/.test(source)) found.push("mediaUrl");
  return found;
}

describe("a prévia nunca guarda imagem", () => {
  it("nenhum arquivo da prévia sobe ao Storage, gera URL pública, grava foto de peça/look ou manda imagem por URL", () => {
    const offenders = TRYON_FILES.map((file) => ({ file, found: storesImages(readFileSync(path.join(SRC, file), "utf8")) })).filter((entry) => entry.found.length > 0);
    expect(offenders).toEqual([]);
  });

  it("a prévia vai embutida (imageBase64) e a foto dela é baixada da Z-API na hora", () => {
    const source = readFileSync(path.join(SRC, "services/tryon-generate.ts"), "utf8");
    expect(source).toContain("imageBase64");
    expect(source).toContain("downloadMedia");
  });

  it("o detector pega as formas de guardar", () => {
    expect(storesImages("await deps.storage.upload({ path })")).toEqual(["storage.upload"]);
    expect(storesImages("storage.publicUrl(path)")).toEqual(["publicUrl"]);
    expect(storesImages("await tx.insert(productImages).values({})")).toEqual(["product_images"]);
    expect(storesImages("import { customerLooks } from '@/db/schema'")).toEqual(["customer_looks"]);
    expect(storesImages("sendMediaMessage(db, p, { kind: 'image', imageUrl: url })")).toEqual(["imageUrl"]);
    expect(storesImages("await db.update(waMessages).set({ mediaUrl: url })")).toEqual(["mediaUrl"]);
    // Ler a URL da foto dela para baixar da Z-API não é guardar.
    expect(storesImages("select({ mediaUrl: waMessages.mediaUrl })")).toEqual([]);
    expect(storesImages("const x = { imageBase64: data }")).toEqual([]);
  });
});
