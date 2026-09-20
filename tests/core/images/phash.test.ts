// dHash puro: determinístico, 64 bits, distância de Hamming e o hex de 16.
import { describe, expect, it } from "vitest";

import { DHASH_HEIGHT, DHASH_WIDTH, dhashFromGray, hammingDistance, hexToPhash, PHASH_HEX_LENGTH, phashToHex } from "@/core/images/phash";

/** Pixels 9 × 8 gerados por uma função (x, y) → cinza. */
function gray(fn: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(DHASH_WIDTH * DHASH_HEIGHT);
  for (let y = 0; y < DHASH_HEIGHT; y += 1) for (let x = 0; x < DHASH_WIDTH; x += 1) out[y * DHASH_WIDTH + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
  return out;
}

describe("dhashFromGray", () => {
  it("gradiente que clareia para a direita: nenhum pixel é mais claro que o vizinho → hash 0; o inverso → todos os 64 bits", () => {
    expect(dhashFromGray(gray((x) => x * 20))).toBe(BigInt(0));
    const allOnes = dhashFromGray(gray((x) => 255 - x * 20));
    expect(phashToHex(allOnes)).toBe("ffffffffffffffff");
    expect(hammingDistance(allOnes, BigInt(0))).toBe(64);
  });

  it("é determinístico e a ordem dos bits é linha a linha (o primeiro par da primeira linha é o bit mais alto)", () => {
    const pixels = gray((x, y) => (y === 0 && x === 0 ? 255 : 0));
    const hash = dhashFromGray(pixels);
    expect(dhashFromGray(pixels)).toBe(hash);
    expect(phashToHex(hash)).toBe("8000000000000000");
  });

  it("um ruído pequeno muda poucos bits; uma imagem invertida muda todos", () => {
    const base = gray((x, y) => 128 + 40 * Math.sin(x * 1.3 + y * 0.7));
    const noisy = gray((x, y) => 128 + 40 * Math.sin(x * 1.3 + y * 0.7) + ((x * 7 + y * 3) % 5) - 2);
    const inverted = gray((x, y) => 255 - (128 + 40 * Math.sin(x * 1.3 + y * 0.7)));
    const a = dhashFromGray(base);
    expect(hammingDistance(a, dhashFromGray(noisy))).toBeLessThanOrEqual(8);
    // Par de vizinhos IGUAIS dá bit 0 nas duas (a comparação é estrita): quase tudo inverte, não tudo.
    expect(hammingDistance(a, dhashFromGray(inverted))).toBeGreaterThanOrEqual(60);
  });

  it("recusa buffer curto", () => {
    expect(() => dhashFromGray(new Uint8Array(10))).toThrow(RangeError);
  });
});

describe("phashToHex / hexToPhash", () => {
  it("ida e volta com zeros à esquerda; hex torto, maiúsculo ou curto vira null", () => {
    const hash = BigInt("0x3639512fece06c60");
    expect(phashToHex(hash)).toBe("3639512fece06c60");
    expect(phashToHex(hash)).toHaveLength(PHASH_HEX_LENGTH);
    expect(hexToPhash("3639512fece06c60")).toBe(hash);
    expect(phashToHex(BigInt(1))).toBe("0000000000000001");
    expect(hexToPhash("0000000000000001")).toBe(BigInt(1));
    expect(hexToPhash("3639512FECE06C60")).toBeNull();
    expect(hexToPhash("3639512fece06c6")).toBeNull();
    expect(hexToPhash("xyz")).toBeNull();
    expect(hexToPhash("")).toBeNull();
  });
});
