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
  const current = editions.find((e) => e.isCurrent);
  if (current) return `A ${current.name} está no ar com ${pieces(current.products)}${missing(current.missingPhoto)}`;
  const upcoming = editions
    .filter((e): e is EditionDigestInput & { daysUntil: number } => e.daysUntil !== null && e.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (!upcoming) return null;
  if (upcoming.daysUntil === 0) return `A ${upcoming.name} começa hoje com ${pieces(upcoming.products)}${missing(upcoming.missingPhoto)}`;
  const days = upcoming.daysUntil === 1 ? "Falta 1 dia" : `Faltam ${upcoming.daysUntil} dias`;
  return `${days} para a ${upcoming.name} — ${pieces(upcoming.products)} ${upcoming.products === 1 ? "escolhida" : "escolhidas"}${missing(upcoming.missingPhoto)}`;
}

/**
 * A versão curta para a faixa do topo da imagem (ao lado da data):
 * "Faltam 28 dias para a Edição Círio" / "A Edição Círio está no ar".
 */
export function editionHeadline(editions: readonly EditionDigestInput[]): string | null {
  const current = editions.find((e) => e.isCurrent);
  if (current) return `A ${current.name} está no ar`;
  const upcoming = editions
    .filter((e): e is EditionDigestInput & { daysUntil: number } => e.daysUntil !== null && e.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (!upcoming) return null;
  if (upcoming.daysUntil === 0) return `A ${upcoming.name} começa hoje`;
  return upcoming.daysUntil === 1 ? `Falta 1 dia para a ${upcoming.name}` : `Faltam ${upcoming.daysUntil} dias para a ${upcoming.name}`;
}
