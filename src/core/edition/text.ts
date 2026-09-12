// Os textos do cartão da edição — PURO. Tudo que entra na imagem passa por
// aqui: só latino (o desenho não pode buscar fonte pela rede), numa linha,
// dentro do teto — cortado no fim de uma frase, avisando — e um padrão por
// família quando a ficha da peça está vazia, para o cartão nunca sair com
// um quadro em branco.

import { CARE_SYMBOLS, parseCareNotes } from "@/core/catalog/care";
import { isNotClothing } from "@/core/catalog/family";
import { fold } from "@/core/catalog/product-images";
import { normalizeReceiptText } from "@/core/receipts/types";

/**
 * Os tetos são em UNIDADES DE LARGURA, não em caracteres: uma minúscula vale
 * 1, uma maiúscula 1,3 na Jost dos quadros e 1,45 na Cormorant itálica da
 * frase e do título (medido nas fontes embutidas), espaço e pontuação 0,45.
 * Assim uma ficha em CAIXA ALTA é cortada antes de estourar as linhas — e o
 * orçamento de altura do cartão inteiro fecha em core/edition/layout.ts.
 */
export const EDITION_CURATOR_MAX = 300;
/** Cada quadro pequeno ("Como veste", "Cuidados"): três linhas. */
export const EDITION_NOTE_MAX = 165;
/** O nome da peça: duas linhas de título. */
export const EDITION_TITLE_MAX = 60;

export type WidthFont = "sans" | "serif";
const UPPER_UNITS: Record<WidthFont, number> = { sans: 1.3, serif: 1.45 };

function charUnits(char: string, font: WidthFont): number {
  if (/[\p{Lu}]/u.test(char)) return UPPER_UNITS[font];
  if (/[\p{Ll}]/u.test(char)) return 1;
  if (/[\p{N}]/u.test(char)) return 1.1;
  // Travessão e reticências são largos (≈ 1 em); meia-risca, metade disso.
  if (char === "—" || char === "…") return 2.2;
  if (char === "–") return 1.2;
  return 0.45;
}

/** Largura estimada do texto, na régua dos tetos acima. */
export function textWidthUnits(text: string, font: WidthFont = "sans"): number {
  let units = 0;
  for (const char of text) units += charUnits(char, font);
  return units;
}

/** Quantos caracteres cabem em `maxUnits`, do início do texto. */
function charsWithinUnits(text: string, maxUnits: number, font: WidthFont): number {
  let units = 0;
  let index = 0;
  for (const char of text) {
    const next = units + charUnits(char, font);
    if (next > maxUnits) break;
    units = next;
    index += char.length;
  }
  return index;
}

function cleanLine(raw: string): string {
  // A mesma régua do desenho (normalizeReceiptText): NFC, traços e aspas
  // tipográficos, só o que as fontes embutidas têm — contada aqui para o
  // teto valer sobre o texto que de fato sai. Marcador de lista no começo
  // da linha ("- ", "• ") não vai para o cartão.
  return normalizeReceiptText(raw.replace(/[\t\f\v]+/g, " ").replace(/^\s*[-•*·–—]\s+/, ""));
}

/** As linhas limpas de um texto, sem as vazias. */
function cleanLines(value: string | null | undefined): string[] {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanLine)
    .filter((line) => line !== "");
}

function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

const QUOTE = /["'“”‘’«»]/;

/**
 * Tira as aspas das pontas quando a linha INTEIRA está entre aspas — o
 * desenho já põe as dele. Uma citação no meio ou no fim ("… chamou de
 * "a peça do ano"") fica como está, com as duas aspas.
 */
function stripQuotes(text: string): string {
  const trimmed = text.trim();
  if (!QUOTE.test(trimmed.charAt(0)) || !QUOTE.test(trimmed.charAt(trimmed.length - 1))) return trimmed;
  return trimmed.slice(1, -1).trim();
}

export type FittedNote = { text: string | null; truncated: boolean };

/** "aprox.", "Obs.", "ref.", uma letra só: ponto que não fecha frase. */
const ABBREVIATION_BEFORE_DOT = /(^|[\s(])(aprox|obs|ref|comp|larg|alt|med|min|max|cm|mm|kg|n[º°o]?|p|[a-z])$/i;

/** O último ". ", "! " ou "? " que fecha uma frase de verdade (não abreviação, não antes de número). */
function lastSentenceEnd(text: string): number {
  for (let index = text.length - 2; index >= 0; index -= 1) {
    const char = text.charAt(index);
    if ((char !== "." && char !== "!" && char !== "?") || text.charAt(index + 1) !== " ") continue;
    if (char === "." && ABBREVIATION_BEFORE_DOT.test(text.slice(0, index))) continue;
    if (/[\d]/.test(text.charAt(index + 2))) continue;
    return index;
  }
  return -1;
}

/**
 * Cabe no teto: inteiro quando cabe; senão, até o fim da última frase que
 * cabe (". ! ?"), sem reticências; se nenhuma frase cabe, na última palavra,
 * com reticências. Nunca termina em "·", "—" ou outra pontuação solta.
 */
function fitText(text: string, maxUnits: number, font: WidthFont = "sans"): FittedNote {
  if (textWidthUnits(text, font) <= maxUnits) return { text, truncated: false };
  const roomChars = charsWithinUnits(text, maxUnits, font);
  const room = text.slice(0, roomChars);
  // Uma frase inteira que ocupe ao menos um quarto do quadro vale mais do
  // que uma frase e meia com reticências.
  const sentenceEnd = lastSentenceEnd(room);
  if (sentenceEnd >= roomChars / 4) return { text: room.slice(0, sentenceEnd + 1), truncated: true };
  // As reticências também ocupam lugar: o corte deixa espaço para elas.
  const roomForEllipsis = text.slice(0, charsWithinUnits(text, maxUnits - charUnits("…", font), font));
  const lastSpace = roomForEllipsis.lastIndexOf(" ");
  const cut = lastSpace > roomChars / 2 ? roomForEllipsis.slice(0, lastSpace) : roomForEllipsis;
  return { text: `${cut.replace(/[\p{P}\p{S}\s]+$/u, "")}…`, truncated: true };
}

/**
 * Um quadro do cartão a partir de um texto da ficha: linhas viram uma só,
 * separadas por " · " (uma ficha escrita em linhas não emenda), limpo e no
 * teto. Vazio, ou só pontuação, vira null.
 */
export function fitEditionNote(
  value: string | null | undefined,
  max = EDITION_NOTE_MAX,
  options: { quotes?: boolean } = {},
): FittedNote {
  const lines = cleanLines(value);
  const joined = options.quotes
    ? // Parágrafos da nota viram frases: o que não termina em pontuação ganha ponto.
      lines
        .map(stripQuotes)
        .filter((line) => line !== "")
        .map((line) => (/[.!?…:;,—-]["'“”‘’«»]?$/.test(line) ? line : `${line}.`))
        .join(" ")
    : lines.join(" · ");
  if (joined === "" || !hasWords(joined)) return { text: null, truncated: false };
  // A frase da curadora sai na itálica serifada; os quadros, na sem-serifa.
  return fitText(joined, max, options.quotes ? "serif" : "sans");
}

/** O nome da peça no título (serifa): até duas linhas; mais que isso corta na palavra, avisando. */
export function fitEditionTitle(name: string): { text: string; truncated: boolean } {
  const clean = cleanLine(name);
  const fitted = fitText(clean, EDITION_TITLE_MAX, "serif");
  return { text: fitted.text ?? clean, truncated: fitted.truncated };
}

/** O convite ao lado do QR, conforme o destino dele. */
export function editionInvite(qrTarget: "peca" | "home"): string {
  return qrTarget === "peca"
    ? "Veja a peça, a ficha e a nossa conversa."
    : "Conheça a maison e fale com a curadora.";
}

/** Só o texto, para quem não precisa do aviso de corte. */
export function normalizeEditionNote(value: string | null | undefined, max = EDITION_NOTE_MAX): string | null {
  return fitEditionNote(value, max).text;
}

/**
 * Família da peça: primeiro pela categoria; só se ela não disser nada, pelo
 * nome. Dentro de cada um, o que é acessório, sobreposição ou conjunto vem
 * antes das peças de corpo — e "vestido" por último, porque "longo", "midi"
 * e "curto" aparecem em nomes de saia, colar e top.
 */
export type EditionFamily =
  | "vestido"
  | "blusa"
  | "saia"
  | "calca"
  | "sobreposicao"
  | "conjunto"
  | "acessorio"
  | "geral"
  | "nenhuma";

const FAMILY_HINTS: [Exclude<EditionFamily, "geral" | "nenhuma">, RegExp][] = [
  [
    "acessorio",
    /acessor|bijut|\bjoias?\b|semi-?joia|\bbolsas?\b|\btote\b|clutch|mochila|carteira|necessaire|\bbrincos?\b|\bcolar(es)?\b|pulseir|\banel\b|\baneis\b|argola|gargantilha|bracelete|tornozeleira|choker|tiara|presilha|turbante|\blencos?\b|echarpe|cachecol|chapeu|\bbone\b|\bcintos?\b|oculos|\bmeias?\b|calcad|sandal|sapat|\btenis\b|rasteir|papete|tamanco|anabela|mocassim|espadrille|alpargata|\bmule\b|\bbotas?\b|chinel|scarpin/,
  ],
  ["sobreposicao", /kimono|jaquet|casaco|blazer|cardig|colete|parka|trench|sobretudo/],
  ["conjunto", /conjunt|macac/],
  ["saia", /\bsaias?\b/],
  ["calca", /\bcalcas?\b|\bjeans\b|pantalon|\bshorts?\b|bermud|legging/],
  ["blusa", /\bblus|\bcamis(a|eta|ete)s?\b|cropp|baby ?look|regat|\btop\b|\bbody\b|\btricot\b|\bmalha\b|moletom|sueter|t-shirt/],
  ["vestido", /vestid|\blongo\b|\bmidi\b|\bcurto\b/],
];

function familyFrom(text: string): EditionFamily | null {
  if (text === "") return null;
  for (const [family, pattern] of FAMILY_HINTS) {
    if (pattern.test(text)) return family;
  }
  return null;
}

/**
 * A peça vem na frente do nome ("Vestido Áurea", "Saia Lua", "Blusa com
 * Colar"): a primeira palavra decide. "Conjunto" não entra aqui de propósito:
 * "Conjunto colar e brinco" é acessório, e isso a lista geral resolve.
 */
const FIRST_WORD_HINTS: [Exclude<EditionFamily, "geral" | "nenhuma">, RegExp][] = [
  // Radical só onde é seguro (vestido/vestidinho, blusa/blusinha); o resto é
  // palavra inteira: "Botão de Rosa" não é bota, "Topázio" não é top,
  // "Anelise" não é anel, "Calcinha" não é calça.
  ["vestido", /^vestid/],
  ["blusa", /^(blus|camis(a|eta|ete)s?$|cropp|regat|tops?$|body$|bodies$|tricot$|moletom|sueter|t-shirts?$|baby$)/],
  ["saia", /^saias?$/],
  ["calca", /^(calcas?$|jeans$|pantalon|shorts?$|bermud|leggings?$)/],
  ["sobreposicao", /^(kimono|jaquet|casaco|blazer|cardig|colete|parka|trench|sobretudo)/],
  ["conjunto", /^macac/],
  [
    "acessorio",
    /^(bolsas?$|tote$|clutch|mochila|carteira|necessaire|brinc|colar(es)?$|pulseir|anel$|aneis$|argola|gargantilha|bracelete|tornozeleira|choker|tiara|presilha|turbante|lencos?$|echarpe|cachecol|chapeu|bone$|cintos?$|oculos|meias?$|sandal|sapat|tenis$|rasteir|papete|tamanco|anabela|mocassim|espadrille|alpargata|mules?$|botas?$|chinel|scarpin|bijut)/,
  ],
];

function familyFromName(name: string): EditionFamily | null {
  const folded = fold(name);
  const first = folded.split(/\s+/)[0] ?? "";
  for (const [family, pattern] of FIRST_WORD_HINTS) {
    if (pattern.test(first)) return family;
  }
  return familyFrom(folded);
}

export function editionFamily(categoryName: string | null | undefined, productName: string): EditionFamily {
  // A categoria de roupa, quando diz a família, vence qualquer palavra do nome.
  const fromCategory = familyFrom(fold(categoryName ?? ""));
  if (fromCategory) return fromCategory;
  if (isNotClothing(categoryName, productName)) return "nenhuma";
  return familyFromName(productName) ?? "geral";
}

/** "Como vestir em Belém" quando a ficha não diz: o clima da cidade fala. */
export const DEFAULT_WEAR: Record<Exclude<EditionFamily, "nenhuma">, string> = {
  vestido: "Belém pede leveza: vai bem sozinho no calor do dia e, à noite, com uma sandália de tira fina e um brinco que fale por você.",
  blusa: "Com a calça de alfaiataria fica de trabalho; com a saia e uma sandália rasteira, de fim de tarde na orla. Tecido que respira no calor.",
  saia: "Com uma blusa leve por dentro e sandália baixa, vai da tarde no Ver-o-Peso ao jantar. Deixa o ar passar — Belém agradece.",
  calca: "Com uma blusa fresca e sandália, é a peça de todo dia: vai ao trabalho de manhã e segue para o encontro à noite sem trocar.",
  sobreposicao: "Por cima do vestido ou da blusa, aberta, para o ar-condicionado e a noite na orla. Tira, dobra na bolsa e segue o dia.",
  conjunto: "Vai completo, de uma vez, ou cada parte com o que você já tem no armário. Tecido pensado para o calor úmido da cidade.",
  acessorio: "É o detalhe que fecha o look: use com o básico do dia a dia e deixe que ele conte a história.",
  geral: "Feita para o clima de Belém: tecido que respira, caimento que acompanha o dia. Use como você é.",
};

/** "Cuidados na umidade" sem pictogramas na ficha. */
export const DEFAULT_CARE: Record<Exclude<EditionFamily, "nenhuma">, string> = {
  vestido: "Lave à mão com sabão neutro, seque à sombra e guarde bem seca, longe do plástico: a umidade de Belém pede ar.",
  blusa: "Lave à mão ou no ciclo delicado, seque à sombra e passe em temperatura baixa. Guarde seca, o mofo gosta de armário fechado.",
  saia: "Lave à mão com sabão neutro e seque à sombra, do avesso. Guarde seca e arejada — a umidade daqui é traiçoeira.",
  calca: "Lave do avesso, em água fria, e seque à sombra. Passe em temperatura baixa e guarde bem seca.",
  sobreposicao: "Lave à mão ou no delicado, seque à sombra no cabide, sem torcer. Guarde arejada, nunca em saco plástico.",
  conjunto: "As duas partes juntas, à mão ou no delicado, secando à sombra. Guarde secas e arejadas.",
  acessorio: "Guarde em saquinho de tecido, longe do sol e da umidade. Limpe com pano seco.",
  geral: "Lave à mão com sabão neutro, seque à sombra e guarde bem seca: a umidade de Belém pede cuidado.",
};

export type NoteSource = "ficha" | "padrao";

/**
 * "Cuidados na umidade" a partir da ficha: o texto livre da dona entra
 * inteiro e primeiro; os pictogramas ("Lavar à mão · Secar à sombra") entram
 * enquanto couberem. Sem nada, o padrão da família.
 */
export function careNoteFor(
  careNotes: string | null | undefined,
  family: Exclude<EditionFamily, "nenhuma">,
): FittedNote & { source: NoteSource; symbolsDropped: number } {
  const parsed = parseCareNotes(careNotes);
  const free = fitEditionNote(parsed.freeText.join("\n"));
  const labels = parsed.symbols.map((key) => CARE_SYMBOLS[key].label);
  if (free.text === null && labels.length === 0) {
    return { text: DEFAULT_CARE[family], truncated: false, source: "padrao", symbolsDropped: 0 };
  }
  const parts = free.text ? [free.text] : [];
  let symbolsDropped = 0;
  for (const label of labels) {
    const candidate = [...parts, label].join(" · ");
    if (textWidthUnits(candidate) > EDITION_NOTE_MAX) {
      symbolsDropped += 1;
      continue;
    }
    parts.push(label);
  }
  return { text: parts.join(" · "), truncated: free.truncated, source: "ficha", symbolsDropped };
}

/** "Como veste" da ficha (caimento, altura da modelo); sem ela, o padrão de Belém. */
export function wearNoteFor(
  fitNotes: string | null | undefined,
  family: Exclude<EditionFamily, "nenhuma">,
): FittedNote & { source: NoteSource } {
  const fitted = fitEditionNote(fitNotes);
  return fitted.text
    ? { ...fitted, source: "ficha" }
    : { text: DEFAULT_WEAR[family], truncated: false, source: "padrao" };
}

export type EditionTextsInput = {
  productName: string;
  categoryName: string | null;
  curatorNote: string | null;
  fitNotes: string | null;
  careNotes: string | null;
};

export type EditionTexts = {
  family: Exclude<EditionFamily, "nenhuma">;
  /** O nome da peça como sai no título (até duas linhas). */
  title: string;
  titleTruncated: boolean;
  curatorNote: string | null;
  curatorTruncated: boolean;
  wearNote: string;
  /** "ficha" = o rótulo do cartão diz "COMO VESTE"; "padrao" = "COMO VESTIR EM BELÉM". */
  wearSource: NoteSource;
  wearTruncated: boolean;
  careNote: string;
  /** O texto de cuidados escrito pela dona foi cortado. */
  careTruncated: boolean;
  /** Pictogramas que ficaram de fora por falta de espaço. */
  careSymbolsDropped: number;
};

/** Os três textos do cartão, prontos para o desenho; null = a peça não é roupa. */
export function editionTexts(input: EditionTextsInput): EditionTexts | null {
  const family = editionFamily(input.categoryName, input.productName);
  if (family === "nenhuma") return null;
  const title = fitEditionTitle(input.productName);
  const curator = fitEditionNote(input.curatorNote, EDITION_CURATOR_MAX, { quotes: true });
  const wear = wearNoteFor(input.fitNotes, family);
  const care = careNoteFor(input.careNotes, family);
  return {
    family,
    title: title.text,
    titleTruncated: title.truncated,
    curatorNote: curator.text,
    curatorTruncated: curator.truncated,
    wearNote: wear.text as string,
    wearSource: wear.source,
    wearTruncated: wear.truncated,
    careNote: care.text as string,
    careTruncated: care.truncated,
    careSymbolsDropped: care.symbolsDropped,
  };
}
