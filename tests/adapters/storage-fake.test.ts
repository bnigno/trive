import { describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";

describe("FakeFileStorage.download", () => {
  it("devolve os bytes e o content-type do que foi enviado; caminho inexistente falha", async () => {
    const storage = new FakeFileStorage();
    const { path } = await storage.upload({
      path: "produtos/x.webp",
      data: Buffer.from("RIFF"),
      contentType: "image/webp",
    });
    const file = await storage.download(path);
    expect(file.data.toString()).toBe("RIFF");
    expect(file.contentType).toBe("image/webp");
    await expect(storage.download("produtos/nao-existe.webp")).rejects.toThrow(/não existe/);
  });
});
