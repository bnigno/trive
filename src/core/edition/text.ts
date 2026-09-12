// Os textos do cartão da edição — PURO. Tudo que entra na imagem passa por
// aqui: só latino (o desenho não pode buscar fonte pela rede), poucas
// linhas, e um padrão por categoria quando a ficha da peça está vazia, para
// o cartão nunca sair com um quadro em branco.

import { CARE_SYMBOLS, parseCareNotes } from "@/core/catalog/care";
import { fold } from "@/core/catalog/product-images";

/** A frase da curadora: uma ou duas linhas, no máximo isto. */
export const EDITION_CURATOR_MAX = 220;
/** Cada quadro pequeno ("Como vestir", "Cuidados"): cabe em três linhas curtas. */
export const EDITION_NOTE_MAX = 170;
const MAX_LINES = 4;

/**
 * Texto como cabe no cartão: só letras latinas, números e pontuação (emoji
 * faria o desenho buscar fonte pela rede), espaço aparado, no máximo quatro
 * linhas e `max` caracteres — cortado na última palavra inteira, com
 * reticências. Vazio vira null.
 */
export function normalizeEditionNote(value: string | null | undefined, max = EDITION_NOTE_MAX): string | null {
  const lines: string[] = [];
  for (const raw of (value ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw
      .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}]/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (line === "") continue;
    lines.push(line);
    if (lines.length === MAX_LINES) break;
  }
  const text = lines.join("\n");
  if (text === "" || !/[\p{L}\p{N}]/u.test(text)) return null;
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const lastBreak = Math.max(room.lastIndexOf(" "), room.lastIndexOf("\n"));
  const cut = lastBreak > max / 2 ? room.slice(0, lastBreak) : room;
  return `${cut.trimEnd().replace(/[,;:.!?…-]+$/, "")}…`;
}

/**
 * Família da peça pelo nome da categoria (ou da própria peça), sem depender
 * de slug fixo: "Vestidos", "Vestido longo" e "vestidos de festa" caem no
 * mesmo padrão.
 */
export type EditionFamily = "vestido" | "blusa" | "saia" | "calca" | "conjunto" | "acessorio" | "geral";

const FAMILY_HINTS: [EditionFamily, RegExp][] = [
  ["vestido", /vestid|longo|midi|curto\b/],
  ["blusa", /blus|camis|cropp|baby ?look|regat|top\b|body\b|tricot|malha/],
  ["saia", /saia/],
  ["calca", /calc|short|bermud|pantalon/],
  ["conjunto", /conjunt|macac|kimono|jaquet|casaco|colete/],
  ["acessorio", /acessor|bolsa|brinc|colar|pulseir|lenco|chapeu|cinto|bone|sandal|sapat/],
];

export function editionFamily(categoryName: string | null | undefined, productName: string): EditionFamily {
  const haystack = `${fold(categoryName ?? "")} ${fold(productName)}`;
  for (const [family, pattern] of FAMILY_HINTS) {
    if (pattern.test(haystack)) return family;
  }
  return "geral";
}

/** "Como vestir em Belém" quando a ficha não diz: o clima da cidade fala. */
export const DEFAULT_WEAR: Record<EditionFamily, string> = {
  vestido: "Belém pede leveza: vai bem sozinho no calor do dia e, à noite, com uma sandália de tira fina e um brinco que fale por você.",
  blusa: "Com a calça de alfaiataria fica de trabalho; com a saia e uma sandália rasteira, de fim de tarde na orla. Tecido que respira no calor.",
  saia: "Com uma blusa leve por dentro e sandália baixa, vai da tarde no Ver-o-Peso ao jantar. Deixa o ar passar — Belém agradece.",
  calca: "Com uma blusa fresca e sandália, é a peça de todo dia: vai ao trabalho de manhã e segue para o encontro à noite sem trocar.",
  conjunto: "Vai completo, de uma vez, ou cada parte com o que você já tem no armário. Tecido pensado para o calor úmido da cidade.",
  acessorio: "É o detalhe que fecha o look: use com o básico do dia a dia e deixe que ele conte a história.",
  geral: "Feita para o clima de Belém: tecido que respira, caimento que acompanha o dia. Use como você é.",
};

/** "Cuidados na umidade" sem pictogramas na ficha. */
export const DEFAULT_CARE: Record<EditionFamily, string> = {
  vestido: "Lave à mão com sabão neutro, seque à sombra e guarde bem seca, longe do plástico: a umidade de Belém pede ar.",
  blusa: "Lave à mão ou no ciclo delicado, seque à sombra e passe em temperatura baixa. Guarde seca, o mofo gosta de armário fechado.",
  saia: "Lave à mão com sabão neutro e seque à sombra, do avesso. Guarde seca e arejada — a umidade daqui é traiçoeira.",
  calca: "Lave do avesso, em água fria, e seque à sombra. Passe em temperatura baixa e guarde bem seca.",
  conjunto: "As duas partes juntas, à mão ou no delicado, secando à sombra. Guarde secas e arejadas.",
  acessorio: "Guarde em saquinho de tecido, longe do sol e da umidade. Limpe com pano seco.",
  geral: "Lave à mão com sabão neutro, seque à sombra e guarde bem seca: a umidade de Belém pede cuidado.",
};

/**
 * "Cuidados na umidade" a partir da ficha: os pictogramas viram uma frase
 * ("Lavar à mão · Secar à sombra") e o texto livre entra em seguida; sem
 * nada, o padrão da família.
 */
export function careNoteFor(careNotes: string | null | undefined, family: EditionFamily): string {
  const parsed = parseCareNotes(careNotes);
  const parts = [
    ...parsed.symbols.map((key) => CARE_SYMBOLS[key].label),
    ...parsed.freeText,
  ];
  const fromSheet = normalizeEditionNote(parts.join(" · "));
  return fromSheet ?? DEFAULT_CARE[family];
}

/** "Como vestir em Belém" a partir da ficha ("Como veste"); sem ela, o padrão. */
export function wearNoteFor(fitNotes: string | null | undefined, family: EditionFamily): string {
  return normalizeEditionNote(fitNotes) ?? DEFAULT_WEAR[family];
}

export type EditionTextsInput = {
  productName: string;
  categoryName: string | null;
  curatorNote: string | null;
  fitNotes: string | null;
  careNotes: string | null;
};

/** Os três textos do cartão, prontos para o desenho. */
export function editionTexts(input: EditionTextsInput): {
  curatorNote: string | null;
  wearNote: string;
  careNote: string;
  family: EditionFamily;
} {
  const family = editionFamily(input.categoryName, input.productName);
  return {
    family,
    curatorNote: normalizeEditionNote(input.curatorNote, EDITION_CURATOR_MAX),
    wearNote: wearNoteFor(input.fitNotes, family),
    careNote: careNoteFor(input.careNotes, family),
  };
}
