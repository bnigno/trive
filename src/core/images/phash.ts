// Impressão digital de imagem (dHash) — PURO. Reduz a imagem a 9 × 8 tons de
// cinza (quem faz isso é o sharp, fora daqui) e guarda, para cada par de
// pixels vizinhos na horizontal, se o da esquerda é mais claro: 8 linhas × 8
// comparações = 64 bits. Duas cópias da mesma foto (reencodada, menor, com um
// texto por cima) ficam a poucos bits de distância; fotos diferentes ficam a
// ~32. O limiar do que é "a mesma foto" vive em core/bot/photo-match.ts.

export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;
/** 64 bits em hexadecimal, sempre com zeros à esquerda. */
export const PHASH_HEX_LENGTH = 16;

const HEX_16 = /^[0-9a-f]{16}$/;

/**
 * Pixels em tons de cinza, linha a linha (width × height valores de 0 a 255),
 * como o sharp devolve com `.grayscale().raw()`. Lança se faltar pixel.
 */
export function dhashFromGray(pixels: ArrayLike<number>, width = DHASH_WIDTH, height = DHASH_HEIGHT): bigint {
  if (pixels.length < width * height) {
    throw new RangeError(`dHash precisa de ${width * height} pixels, recebeu ${pixels.length}.`);
  }
  // BigInt() em vez de literais `0n`: o alvo do TypeScript é ES2017.
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let bits = ZERO;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = pixels[y * width + x];
      const right = pixels[y * width + x + 1];
      bits = (bits << ONE) | (left > right ? ONE : ZERO);
    }
  }
  return bits;
}

/** Quantos bits diferem entre dois hashes (0 = idênticos, 64 = opostos). */
export function hammingDistance(a: bigint, b: bigint): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let x = a ^ b;
  let count = 0;
  while (x > ZERO) {
    count += Number(x & ONE);
    x >>= ONE;
  }
  return count;
}

export function phashToHex(bits: bigint): string {
  return bits.toString(16).padStart(PHASH_HEX_LENGTH, "0");
}

/** Só aceita os 16 hexadecimais minúsculos que gravamos; qualquer outra coisa é null. */
export function hexToPhash(hex: string): bigint | null {
  return HEX_16.test(hex) ? BigInt(`0x${hex}`) : null;
}
