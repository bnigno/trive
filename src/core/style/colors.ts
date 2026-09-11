// Amostras de cor para a cartela: o nome da cor no catálogo (livre, em
// português) vira um hexadecimal aproximado para o swatch. Sem match, a
// amostra fica neutra com o nome escrito. Puro.

const SWATCHES: [RegExp, string][] = [
  [/\bpreto|black|noir\b/i, "#141210"],
  [/\bbranco|white|off[\s-]?white\b/i, "#f5f1e8"],
  [/\bareia|sand|bege|beige|cru|nude|champagne\b/i, "#d9c7a7"],
  [/\bcaramelo|camel|caramel|mel\b/i, "#b07a3a"],
  [/\bterracota|terracotta|tijolo|ferrugem\b/i, "#b5533b"],
  [/\bmarrom|brown|chocolate|caf[eé]|tabaco|espresso\b/i, "#5b3a29"],
  [/\bvinho|bord[oô]|burgundy|marsala\b/i, "#6b1f2e"],
  [/\bvermelho|red|cereja\b/i, "#b3202b"],
  [/\brosa|pink|blush|rosé\b/i, "#dcaab0"],
  [/\blaranja|orange|tangerina\b/i, "#d97a2b"],
  [/\bamarelo|yellow|mostarda|ouro|dourado|gold\b/i, "#c9a54a"],
  [/\bverde\s*militar|oliva|olive|khaki|caqui\b/i, "#6b6f3f"],
  [/\bverde|green|esmeralda|menta|sálvia|salvia\b/i, "#3e6b4f"],
  [/\bazul\s*marinho|navy|marinho\b/i, "#1f2a44"],
  [/\bazul|blue|celeste|petr[óo]leo\b/i, "#4a6b8a"],
  [/\broxo|lil[áa]s|lavanda|violeta|purple|uva\b/i, "#7a5c8e"],
  [/\bcinza|gray|grey|chumbo|grafite\b/i, "#8a8a86"],
  [/\bprata|silver|metal\b/i, "#b9b9b6"],
  [/\bestampad|floral|listrad|xadrez|print\b/i, "#9c8b74"],
];

export function swatchHex(colorName: string): string | null {
  for (const [pattern, hex] of SWATCHES) if (pattern.test(colorName)) return hex;
  return null;
}

/** Texto legível sobre a amostra (preto em cores claras, marfim nas escuras). */
export function swatchInk(hex: string): "#141210" | "#faf7f0" {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#141210" : "#faf7f0";
}
