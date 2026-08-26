"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { evaluateApproval, type PriceBreakdown } from "@/core/pricing";
import { getDb } from "@/db/client";
import { formatCentsBRL, parseBRLToCents } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import {
  createPriceVersion,
  getPricingContext,
  listPriceVersions,
  previewPrice,
  type PriceVersionRow,
} from "@/services/pricing";
import { actionErrorMessage } from "../errors";
import { translateReasons } from "../labels";

const ROUNDING_MODES = ["none", "to_90", "to_99", "to_50", "integer"] as const;

export type CalculatorState = {
  error?: string;
  success?: string;
  /** true quando a versão salva ficou aguardando aprovação. */
  pendente?: boolean;
  preview?: {
    breakdown: PriceBreakdown;
    willRequireApproval: boolean;
    reasonsLabel: string;
    values: {
      variantId: string;
      margem: string;
      custosFixos: string;
      arredondamento: string;
    };
  };
};

function parseVariantId(formData: FormData): string {
  const parsed = z.uuid().safeParse(String(formData.get("variantId") ?? ""));
  if (!parsed.success) {
    throw new RangeError(
      "Variante inválida. Volte para a lista de preços e tente novamente.",
    );
  }
  return parsed.data;
}

/** Input '30' ou '32,5' = 30% / 32,5% -> fração (0.3 / 0.325). */
function parsePercentInput(raw: FormDataEntryValue | null): number {
  const text = String(raw ?? "")
    .trim()
    .replace("%", "")
    .replace(",", ".");
  if (text === "") {
    throw new RangeError("Informe a margem alvo (ex.: 30 para 30%).");
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value >= 100) {
    throw new RangeError(
      "Margem alvo inválida: use um número entre 0 e 99 (ex.: 30 para 30%).",
    );
  }
  return value / 100;
}

function parseOverrides(formData: FormData): {
  targetMarginRate: number;
  otherFixedCents: number;
  roundingMode: (typeof ROUNDING_MODES)[number];
} {
  const targetMarginRate = parsePercentInput(formData.get("margem"));

  const custosRaw = String(formData.get("custosFixos") ?? "").trim();
  const otherFixedCents = custosRaw === "" ? 0 : parseBRLToCents(custosRaw);
  if (otherFixedCents < 0) {
    throw new RangeError("Custos fixos não podem ser negativos.");
  }

  const mode = ROUNDING_MODES.find(
    (m) => m === String(formData.get("arredondamento") ?? ""),
  );
  if (!mode) {
    throw new RangeError("Escolha um modo de arredondamento válido.");
  }

  return { targetMarginRate, otherFixedCents, roundingMode: mode };
}

/**
 * Calcula o preço sugerido (sem persistir) e antecipa se salvar este preço
 * criará uma pendência de aprovação — a mesma régua do createPriceVersion.
 */
export async function previewPriceAction(
  _previous: CalculatorState,
  formData: FormData,
): Promise<CalculatorState> {
  await requireOwner("precos");
  const db = getDb();

  try {
    const variantId = parseVariantId(formData);
    const overrides = parseOverrides(formData);

    const ctx = await getPricingContext(db, variantId);
    const { result } = await previewPrice(db, { variantId, ...overrides });

    // Primeira precificação = nenhuma versão jamais ativada (regra do serviço).
    const versions = await listPriceVersions(db, variantId);
    const isFirstPrice = !versions.some((v) => v.activatedAt !== null);

    const decision = evaluateApproval({
      newPriceCents: result.priceCents,
      previousActivePriceCents: ctx.previousActive?.priceCents ?? null,
      effectiveMarginRate: result.effectiveMarginRate,
      minMarginRate: ctx.policy.minMarginRate,
      totalCostCents:
        ctx.variant.costCents +
        overrides.otherFixedCents +
        ctx.feeRule.fixedFeeCents,
      changePctThreshold: ctx.settings.priceChangePctThreshold,
      isFirstPrice,
      firstPriceRequiresApproval: ctx.settings.firstPriceRequiresApproval,
      isBulk: false,
    });

    return {
      preview: {
        breakdown: result.breakdown,
        willRequireApproval: decision.requiresApproval,
        reasonsLabel: translateReasons(decision.reasons),
        values: {
          variantId,
          margem: String(formData.get("margem") ?? ""),
          custosFixos: String(formData.get("custosFixos") ?? ""),
          arredondamento: overrides.roundingMode,
        },
      },
    };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}

/**
 * Salva uma nova versão de preço: pelo cálculo (modo 'politica', com os
 * overrides digitados) ou na mão (modo 'manual', preço em R$). O fluxo de
 * aprovação embutido decide se ativa direto ou fica pendente.
 */
export async function savePriceAction(
  _previous: CalculatorState,
  formData: FormData,
): Promise<CalculatorState> {
  const user = await requireOwner("precos");
  const db = getDb();

  try {
    const variantId = parseVariantId(formData);
    const modo = String(formData.get("modo") ?? "politica");

    let version: PriceVersionRow;
    if (modo === "manual") {
      const precoRaw = String(formData.get("preco") ?? "").trim();
      if (precoRaw === "") {
        throw new RangeError("Informe o preço desejado (ex.: 149,90).");
      }
      const priceCentsManual = parseBRLToCents(precoRaw);
      if (priceCentsManual <= 0) {
        throw new RangeError("O preço deve ser maior que zero.");
      }
      version = await createPriceVersion(db, {
        variantId,
        userId: user.id,
        origin: "manual",
        priceCentsManual,
      });
    } else {
      const overrides = parseOverrides(formData);
      version = await createPriceVersion(db, {
        variantId,
        userId: user.id,
        origin: "manual",
        overrides,
      });
    }

    revalidatePath("/admin/precos");
    revalidatePath("/admin/precos/pendencias");
    revalidatePath(`/admin/precos/historico/${variantId}`);

    if (version.status === "active") {
      return {
        success: `Preço ${formatCentsBRL(version.priceCents)} ativado — já está valendo.`,
      };
    }
    return {
      success:
        `Preço ${formatCentsBRL(version.priceCents)} enviado para aprovação ` +
        `(motivos: ${translateReasons((version.approvalReasons ?? []) as string[])}).`,
      pendente: true,
    };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}
