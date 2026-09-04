// Ritmo editorial da coleção ("a edição"): funções puras que decidem, para
// cada peça, as colunas que ela ocupa em cada largura e qual rendição de foto
// pedir. Ciclo de 10 peças: no desktop 7/5 · 4/4/4 · 5/7 · 4/4/4; no celular
// as posições 0 e 5 são capas de largura total e as outras fecham em pares.
// A última linha incompleta é fechada (centrada ou em 6/6) para uma sala com
// 2–4 peças não terminar num card solitário.

export type RhythmSize = "cover" | "md";

export interface Rhythm {
  /** Classes do wrapper (filho direto do grid). */
  className: string;
  /** Rendição pedida ao card: "cover" inclui a foto grande no desktop. */
  size: RhythmSize;
  /** Atributo sizes do <img>, derivado das colunas reais. */
  sizes: string;
}

const CYCLE = 10;
/** Linhas do desktop (e do sm) dentro de um ciclo. */
const ROWS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1],
  [2, 3, 4],
  [5, 6],
  [7, 8, 9],
];
/** Posições que abrem um par no celular. */
const PAIR_STARTS = new Set([1, 3, 6, 8]);

// Literais completos para o scanner do Tailwind.
const SM_SPAN: Record<1 | 2, string> = { 1: "sm:col-span-1", 2: "sm:col-span-2" };
const LG_SPAN: Record<4 | 5 | 6 | 7, string> = {
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
};

interface Slot {
  mobile: 1 | 2;
  sm: 1 | 2;
  lg: 4 | 5 | 6 | 7;
  cover: boolean;
  offset: boolean;
}

function baseSlot(pos: number): Slot {
  switch (pos) {
    case 0:
      return { mobile: 2, sm: 2, lg: 7, cover: true, offset: false };
    case 1:
      return { mobile: 1, sm: 1, lg: 5, cover: false, offset: true };
    case 5:
      return { mobile: 2, sm: 1, lg: 5, cover: false, offset: true };
    case 6:
      return { mobile: 1, sm: 2, lg: 7, cover: true, offset: false };
    default:
      return { mobile: 1, sm: 1, lg: 4, cover: false, offset: false };
  }
}

function vw(span: number, columns: number): number {
  return Math.round((span / columns) * 100);
}

export function rhythmFor(index: number, total: number): Rhythm {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Índice inválido: ${index}`);
  }
  if (!Number.isInteger(total) || total <= index) {
    throw new RangeError(`Total inválido: ${total} (índice ${index})`);
  }

  const pos = index % CYCLE;
  const base = index - pos;
  const row = ROWS.find((members) => members.includes(pos))!;
  const present = row.filter((member) => base + member < total).length;
  const closing = present < row.length;

  const slot = baseSlot(pos);
  const classes: string[] = [];
  let smStart: string | null = null;
  let lgStart: string | null = null;

  if (closing) {
    slot.lg = 6;
    slot.offset = false;
    if (present === 1) {
      lgStart = "lg:col-start-4";
      slot.sm = 1;
      smStart = "sm:col-start-2";
    }
  }
  // Celular: quem abriria um par sem parceiro ocupa a linha inteira.
  if (PAIR_STARTS.has(pos) && index === total - 1) slot.mobile = 2;

  if (slot.mobile === 2) classes.push("col-span-2");
  classes.push(SM_SPAN[slot.sm]);
  if (smStart) classes.push(smStart);
  classes.push(LG_SPAN[slot.lg]);
  if (lgStart) classes.push(lgStart);
  if (slot.offset) classes.push("lg:pt-20");

  const sizes = `(min-width: 1024px) ${vw(slot.lg, 12)}vw, (min-width: 640px) ${vw(slot.sm, 3)}vw, ${vw(slot.mobile, 2)}vw`;

  return { className: classes.join(" "), size: slot.cover ? "cover" : "md", sizes };
}

/** Posições do ciclo que funcionam como capa (celular 0 e 5; desktop 0 e 6). */
export const COVER_SLOTS: readonly number[] = [0, 5, 6];

/**
 * Garante que as capas do primeiro ciclo tenham foto: para cada posição de
 * capa cuja ocupante natural não tem foto, traz a próxima peça com foto
 * (índice maior, ainda não promovida). O resto mantém a ordem de chegada.
 */
export function arrangeEdition<T extends { imagePath: string | null }>(
  products: ReadonlyArray<T>,
): T[] {
  const out = [...products];
  for (const slot of COVER_SLOTS) {
    if (slot >= out.length) break;
    if (out[slot].imagePath) continue;
    const from = out.findIndex((item, index) => index > slot && item.imagePath);
    if (from === -1) break;
    const [picked] = out.splice(from, 1);
    out.splice(slot, 0, picked);
  }
  return out;
}
