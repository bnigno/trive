import { describe, expect, it } from "vitest";

import { sha256Hex } from "@/lib/hash";

describe("sha256Hex", () => {
  it("é determinístico, hexadecimal de 64 caracteres e sensível a UTF-8", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("maison")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("TRIVÉ")).not.toBe(sha256Hex("TRIVE"));
  });
});
