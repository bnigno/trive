// Cuidados com a peça — PURO. O campo products.care_notes guarda uma linha
// por item: uma chave de pictograma (hand_wash, dry_shade…) ou texto livre.
// A placa de museu desenha o pictograma; a Lia e o cartão da caixa leem o
// rótulo. Parse e format são inversos um do outro.

export const CARE_SYMBOL_KEYS = [
  "hand_wash",
  "machine_cold",
  "no_bleach",
  "dry_shade",
  "iron_low",
  "no_iron",
  "dry_clean",
  "no_tumble",
] as const;

export type CareSymbolKey = (typeof CARE_SYMBOL_KEYS)[number];

export const CARE_SYMBOLS: Record<CareSymbolKey, { label: string }> = {
  hand_wash: { label: "Lavar à mão" },
  machine_cold: { label: "Máquina, água fria" },
  no_bleach: { label: "Não usar alvejante" },
  dry_shade: { label: "Secar à sombra" },
  iron_low: { label: "Passar em temperatura baixa" },
  no_iron: { label: "Não passar" },
  dry_clean: { label: "Lavagem a seco" },
  no_tumble: { label: "Não usar secadora" },
};

export type CareNotes = {
  symbols: CareSymbolKey[];
  freeText: string[];
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const BY_NORMALIZED = new Map<string, CareSymbolKey>(
  CARE_SYMBOL_KEYS.flatMap((key) => [
    [key, key],
    [normalize(CARE_SYMBOLS[key].label), key],
  ]),
);

function isCareSymbolKey(value: string): value is CareSymbolKey {
  return (CARE_SYMBOL_KEYS as readonly string[]).includes(value);
}

/**
 * Linha que é chave (ou o rótulo escrito por extenso, sem diferenciar caixa
 * e acento) vira pictograma; o resto fica como texto, na ordem, sem repetir.
 */
export function parseCareNotes(text: string | null | undefined): CareNotes {
  const symbols: CareSymbolKey[] = [];
  const freeText: string[] = [];
  for (const rawLine of (text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const key = BY_NORMALIZED.get(normalize(line));
    if (key) {
      if (!symbols.includes(key)) symbols.push(key);
    } else if (!freeText.includes(line)) {
      freeText.push(line);
    }
  }
  return { symbols, freeText };
}

/** Inverso de parseCareNotes: chaves primeiro (na ordem canônica), depois o texto. */
export function formatCareNotes(
  symbols: readonly string[],
  freeText: readonly string[] = [],
): string | null {
  const keys = CARE_SYMBOL_KEYS.filter((key) => symbols.includes(key));
  const lines = [
    ...keys,
    ...freeText.map((line) => line.trim()).filter((line) => line !== "" && !isCareSymbolKey(line)),
  ];
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Rótulos legíveis (pictogramas por extenso + texto), para a Lia e a impressão. */
export function careNotesToLabels(notes: CareNotes): string[] {
  return [...notes.symbols.map((key) => CARE_SYMBOLS[key].label), ...notes.freeText];
}
