// "Pronta para abrir": o que falta a uma peça para ser vendida de verdade —
// PURO. Quem junta os fatos (fotos, preços, estoque, sala) é
// src/services/catalog-readiness.ts; aqui só a regra e os textos.
//
// Bloqueio (vermelho) = a peça não vende: rascunho, sem variação ativa, sem
// preço ativo, sem estoque, sem foto. Aviso (amarelo) = vende, mas mal: uma
// foto só, descrição curta, sem sala, sala sem capa, sem peso (o frete usa o
// peso padrão de 300 g e pode cobrar errado).

export const DESCRIPTION_MIN_CHARS = 200;

export type ReadinessVariantFacts = {
  isActive: boolean;
  weightGrams: number | null;
  hasActivePrice: boolean;
  hasPendingPrice: boolean;
  available: number;
};

export type ReadinessFacts = {
  status: string;
  descriptionLength: number;
  photoCount: number;
  categoryId: string | null;
  categoryHasCover: boolean;
  variants: readonly ReadinessVariantFacts[];
};

export type ReadinessCode =
  | "archived"
  | "draft"
  | "no_active_variant"
  | "price_pending"
  | "no_price"
  | "no_stock"
  | "no_photo"
  | "one_photo"
  | "no_weight"
  | "no_description"
  | "short_description"
  | "no_category"
  | "category_no_cover";

export type ReadinessSeverity = "blocked" | "warning";

/** Âncora na tela da peça (ou das salas) onde o campo que falta mora. */
export type ReadinessAnchor =
  | "status"
  | "dados-basicos"
  | "imagens"
  | "variacoes"
  | "categorias";

export type ReadinessFocus = "description" | "weightGrams";

export type ReadinessIssue = {
  code: ReadinessCode;
  severity: ReadinessSeverity;
  label: string;
  anchor: ReadinessAnchor;
  focus?: ReadinessFocus;
};

export type ReadinessLevel = "ready" | "almost" | "blocked" | "archived";

export type ProductReadiness = {
  level: ReadinessLevel;
  issues: ReadinessIssue[];
  /** O que aparece no selo: o bloqueio mais grave ou, sem bloqueio, o 1º aviso. */
  primaryIssue: ReadinessIssue | null;
};

export type ReadinessSummary = {
  /** Peças prontas (arquivadas ficam de fora da conta). */
  ready: number;
  total: number;
  allReady: boolean;
};

const ISSUES: Record<ReadinessCode, Omit<ReadinessIssue, "code">> = {
  archived: { severity: "blocked", label: "Arquivada", anchor: "status" },
  draft: { severity: "blocked", label: "Em rascunho — ative para vender", anchor: "status" },
  no_active_variant: { severity: "blocked", label: "Sem variação ativa", anchor: "variacoes" },
  price_pending: {
    severity: "blocked",
    label: "Preço aguardando aprovação",
    anchor: "variacoes",
  },
  no_price: { severity: "blocked", label: "Sem preço ativo", anchor: "variacoes" },
  no_stock: { severity: "blocked", label: "Sem estoque disponível", anchor: "variacoes" },
  no_photo: { severity: "blocked", label: "Sem foto", anchor: "imagens" },
  one_photo: { severity: "warning", label: "Só 1 foto", anchor: "imagens" },
  no_weight: {
    severity: "warning",
    label: "Sem peso (o frete usa 300 g)",
    anchor: "variacoes",
    focus: "weightGrams",
  },
  no_description: {
    severity: "warning",
    label: "Sem descrição",
    anchor: "dados-basicos",
    focus: "description",
  },
  short_description: {
    severity: "warning",
    label: `Descrição curta (menos de ${DESCRIPTION_MIN_CHARS} caracteres)`,
    anchor: "dados-basicos",
    focus: "description",
  },
  no_category: { severity: "warning", label: "Sem sala", anchor: "dados-basicos" },
  category_no_cover: { severity: "warning", label: "Sala sem capa", anchor: "categorias" },
};

function issue(code: ReadinessCode): ReadinessIssue {
  return { code, ...ISSUES[code] };
}

/**
 * Bloqueios primeiro, na ordem em que a dona resolveria (ativar → variação →
 * preço → estoque → foto); depois os avisos. O primeiro da lista vira o selo.
 */
export function assessProductReadiness(facts: ReadinessFacts): ProductReadiness {
  if (facts.status === "archived") {
    const only = issue("archived");
    return { level: "archived", issues: [only], primaryIssue: only };
  }

  const issues: ReadinessIssue[] = [];
  const active = facts.variants.filter((variant) => variant.isActive);

  if (facts.status !== "active") issues.push(issue("draft"));
  if (active.length === 0) {
    issues.push(issue("no_active_variant"));
  } else {
    if (!active.some((variant) => variant.hasActivePrice)) {
      issues.push(
        issue(active.some((variant) => variant.hasPendingPrice) ? "price_pending" : "no_price"),
      );
    }
    if (active.reduce((sum, variant) => sum + Math.max(variant.available, 0), 0) <= 0) {
      issues.push(issue("no_stock"));
    }
  }
  if (facts.photoCount === 0) issues.push(issue("no_photo"));

  if (facts.photoCount === 1) issues.push(issue("one_photo"));
  if (facts.descriptionLength === 0) {
    issues.push(issue("no_description"));
  } else if (facts.descriptionLength < DESCRIPTION_MIN_CHARS) {
    issues.push(issue("short_description"));
  }
  if (facts.categoryId === null) {
    issues.push(issue("no_category"));
  } else if (!facts.categoryHasCover) {
    issues.push(issue("category_no_cover"));
  }
  if (
    active.some((variant) => variant.weightGrams === null || variant.weightGrams <= 0)
  ) {
    issues.push(issue("no_weight"));
  }

  const level: ReadinessLevel = issues.some((item) => item.severity === "blocked")
    ? "blocked"
    : issues.length > 0
      ? "almost"
      : "ready";
  return { level, issues, primaryIssue: issues[0] ?? null };
}

/** Conta só o que a loja mostra: peças arquivadas não entram no termômetro. */
export function summarizeReadiness(
  list: readonly { level: ReadinessLevel }[],
): ReadinessSummary {
  const counted = list.filter((item) => item.level !== "archived");
  const ready = counted.filter((item) => item.level === "ready").length;
  return { ready, total: counted.length, allReady: counted.length > 0 && ready === counted.length };
}
