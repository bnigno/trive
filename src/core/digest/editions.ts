// A linha das Edições de Belém no "Bom dia" (PURO): a que está no ar ou a
// próxima a começar, com o que falta para a dona preparar (peças sem foto).
// Sem edição: null e a linha não aparece.
export interface EditionDigestInput {
  name: string;
  /** Está no ar agora. */
  isCurrent: boolean;
  /** Dias até começar (0 = hoje); null = sem data (permanente ou só por hora). */
  daysUntil: number | null;
  /** Peças escolhidas para a edição. */
  products: number;
  /** Dessas, quantas ainda não têm foto. */
  missingPhoto: number;
  /** Tipo da vigência (padrão: por período). */
  kind?: "always" | "period" | "hours" | "period_hours";
  /** Faixa de hora, quando a edição vale só numa parte do dia. */
  hours?: { start: number; end: number } | null;
}

/** A edição que o Bom dia comenta: a datada (no ar, ou a próxima) vence a permanente. */
function pickForDigest(editions: readonly EditionDigestInput[]): { kind: "current" | "today" | "upcoming" | "permanent"; edition: EditionDigestInput } | null {
  const dated = editions.filter((e) => e.kind !== "always");
  const current = dated.find((e) => e.isCurrent);
  if (current) return { kind: "current", edition: current };
  const upcoming = dated
    .filter((e): e is EditionDigestInput & { daysUntil: number } => e.daysUntil !== null && e.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (upcoming) return { kind: upcoming.daysUntil === 0 ? "today" : "upcoming", edition: upcoming };
  const permanent = editions.find((e) => e.isCurrent);
  return permanent ? { kind: "permanent", edition: permanent } : null;
}

function hoursLabel(edition: EditionDigestInput): string {
  return edition.hours ? `, das ${edition.hours.start}h às ${edition.hours.end}h` : "";
}

function pieces(n: number): string {
  return `${n} ${n === 1 ? "peça" : "peças"}`;
}

function missing(n: number): string {
  if (n <= 0) return "";
  return n === 1 ? ", 1 ainda sem foto" : `, ${n} ainda sem foto`;
}

/**
 * "Faltam 31 dias para o Círio — a Edição Círio tem 12 peças, 2 ainda sem foto"
 * "A Edição Círio está no ar com 12 peças"
 * "A Edição Círio começa hoje com 12 peças, 1 ainda sem foto"
 * A vigente vence a futura; entre futuras, a mais próxima.
 */
export function editionDigestLine(editions: readonly EditionDigestInput[]): string | null {
  const picked = pickForDigest(editions);
  if (!picked) return null;
  const e = picked.edition;
  const chosen = `${pieces(e.products)} ${e.products === 1 ? "escolhida" : "escolhidas"}${missing(e.missingPhoto)}`;
  if (picked.kind === "current" || picked.kind === "permanent") return `A ${e.name} está no ar com ${pieces(e.products)}${missing(e.missingPhoto)}`;
  if (picked.kind === "today") return `A ${e.name} é hoje${hoursLabel(e)} — ${chosen}`;
  const days = e.daysUntil === 1 ? "Falta 1 dia" : `Faltam ${e.daysUntil} dias`;
  return `${days} para a ${e.name} — ${chosen}`;
}

/**
 * A versão curta para a faixa do topo da imagem (ao lado da data):
 * "Faltam 28 dias para a Edição Círio" / "A Edição Círio está no ar".
 */
export function editionHeadline(editions: readonly EditionDigestInput[]): string | null {
  const picked = pickForDigest(editions);
  if (!picked) return null;
  const e = picked.edition;
  if (picked.kind === "current" || picked.kind === "permanent") return `A ${e.name} está no ar`;
  if (picked.kind === "today") return `A ${e.name} é hoje${hoursLabel(e)}`;
  return e.daysUntil === 1 ? `Falta 1 dia para a ${e.name}` : `Faltam ${e.daysUntil} dias para a ${e.name}`;
}
