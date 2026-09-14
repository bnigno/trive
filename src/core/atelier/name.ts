// O nome provisório da peça a partir do recado da dona — PURO. "chegou o
// Longo Dunas da Aurora, areia e terra, do P ao GG, custou 120" vira
// "Longo Dunas": tira a saudação e o "chegou", corta no primeiro sinal de
// que o resto é detalhe (vírgula, "da", "custou", tamanho…) e põe em
// caixa de título. Sem nome aproveitável, "Chegada 13/09 18:42" — a dona
// renomeia na ficha; o recado inteiro fica guardado.
import { spDayKey, spMinutesOfDay } from "@/lib/sp-day";

export const DRAFT_NAME_MAX_WORDS = 5;
export const DRAFT_NAME_MAX_CHARS = 60;

const GREETING = /^(oi+|oie|ol[aá]|opa|ei|bom dia|boa tarde|boa noite|lia)[\s,!.:;-]*/i;
const OPENERS =
  /^(acabou de chegar|acabaram de chegar|acaba de chegar|chegou|chegaram|chegando|recebi|recebemos|olha s[oó]|olha|olhe|veja|v[eê]|cadastra|cadastrar|anota|anotar|pe[cç]a nova|nova pe[cç]a|t[aá] aqui|aqui est[aá]|aqui|ent[aã]o|esse|essa|este|esta|isso|isto|[eé]|e)\b[\s,:!.;-]*/i;
const ARTICLE = /^(o|a|os|as|um|uma|uns|umas|do|da|de|dos|das)\s+/i;
const CUT_AT =
  /[,;:.!?\n\r()"“”]|(?:^|\s)(?:da|de|do|das|dos|custou|custa|custaram|custam|por|com|em|no|na|nos|nas|tamanho|tamanhos|tam|numera[cç][aã]o|cor|cores|tem|t[eê]m|s[aã]o|veio|vieram|para|pra|pro|ao|aos|at[eé]|e|r\$|\d+|pp|p|m|g|gg|xg|xgg|eg|egg)(?=\s|$)/i;
const CONNECTIVE = new Set(["de", "da", "do", "das", "dos", "e", "com", "em"]);

function titleCase(words: string[]): string {
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && CONNECTIVE.has(lower)) return lower;
      // Siglas curtas já em caixa alta (GG, PP) ficam como vieram.
      if (word.length <= 3 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** "Chegada 13/09 18:42" no relógio de SP — quando o recado não dá nome. */
export function fallbackDraftName(now: Date): string {
  const [, month, day] = spDayKey(now).split("-");
  const minutes = spMinutesOfDay(now);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `Chegada ${day}/${month} ${hh}:${mm}`;
}

export function draftNameFromNote(note: string, now: Date): string {
  let text = note.replace(/\s+/g, " ").trim();
  // "Oi Lia, olha, chegou essa aqui: ..." — vários abridores em sequência.
  for (let i = 0; i < 5; i += 1) {
    const stripped = text.replace(GREETING, "").replace(OPENERS, "").replace(ARTICLE, "");
    if (stripped === text) break;
    text = stripped;
  }
  const cut = CUT_AT.exec(text);
  const head = (cut ? text.slice(0, cut.index) : text).trim();
  const words = head
    .split(" ")
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, DRAFT_NAME_MAX_WORDS);
  const name = titleCase(words).slice(0, DRAFT_NAME_MAX_CHARS).trim();
  if (name.replace(/[^\p{L}]/gu, "").length < 3) return fallbackDraftName(now);
  return name;
}
