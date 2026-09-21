"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ALL_PAYMENT_METHODS } from "@/core/orders/payment-methods";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  replaceFeeRule,
  ServiceError,
  updateDefaultPolicy,
  updateSetting,
} from "@/services/settings";
import { parseBRLToCents } from "@/lib/money";
import { isValidCnpj } from "@/lib/document";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

/** '4,98' (por cento) -> 0.0498 (fração). Aceita '30' -> 0.3. */
function parsePercentField(raw: string, label: string): number {
  let cents: number;
  try {
    cents = parseBRLToCents(raw.trim());
  } catch {
    throw new ServiceError(
      "percentual_invalido",
      `${label}: informe um número, ex.: 4,98 (para 4,98%).`,
    );
  }
  const rate = cents / 10000;
  if (rate < 0 || rate >= 1) {
    throw new ServiceError(
      "percentual_invalido",
      `${label}: informe um percentual entre 0 e 100.`,
    );
  }
  return rate;
}

/** '2,50' -> 250 centavos. */
function parseMoneyField(raw: string, label: string): number {
  try {
    const cents = parseBRLToCents(raw.trim());
    if (cents < 0) throw new RangeError("negativo");
    return cents;
  } catch {
    throw new ServiceError(
      "valor_invalido",
      `${label}: informe um valor em reais, ex.: 2,50.`,
    );
  }
}

function parseIntField(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError(
      "numero_invalido",
      `${label}: informe um número inteiro maior ou igual a zero.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Taxas do Mercado Pago — nova vigência
// ---------------------------------------------------------------------------

const paymentMethodSchema = z.enum(ALL_PAYMENT_METHODS);

export async function replaceFeeRuleAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const paymentMethod = paymentMethodSchema.parse(formData.get("paymentMethod"));
    const percentRate = parsePercentField(
      String(formData.get("percent") ?? ""),
      "Taxa percentual",
    );
    const fixedFeeCents = parseMoneyField(
      String(formData.get("fixedFee") ?? "0"),
      "Tarifa fixa",
    );
    const settlementDays = parseIntField(
      String(formData.get("settlementDays") ?? ""),
      "Prazo de repasse",
    );
    const installmentsRaw = String(formData.get("installmentsMax") ?? "").trim();
    const installmentsMax =
      installmentsRaw === ""
        ? undefined
        : parseIntField(installmentsRaw, "Parcelas (máximo)");
    if (installmentsMax !== undefined && installmentsMax < 1) {
      return { error: "Parcelas (máximo): informe um número a partir de 1." };
    }

    await replaceFeeRule(getDb(), {
      paymentMethod,
      percentRate,
      fixedFeeCents,
      settlementDays,
      installmentsMax,
      isReferenceForPricing: formData.get("isReference") === "on",
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return {
      success:
        "Nova vigência salva. Os preços já cadastrados NÃO mudam sozinhos — recalcule quando quiser.",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Política de precificação
// ---------------------------------------------------------------------------

const roundingModeSchema = z.enum(["none", "to_90", "to_99", "to_50", "integer"]);
const roundingDirectionSchema = z.enum(["up", "nearest"]);

export async function updatePolicyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const targetMarginRate = parsePercentField(
      String(formData.get("targetMargin") ?? ""),
      "Margem alvo",
    );
    const minMarginRate = parsePercentField(
      String(formData.get("minMargin") ?? ""),
      "Margem mínima",
    );
    const roundingMode = roundingModeSchema.parse(formData.get("roundingMode"));
    const roundingDirection = roundingDirectionSchema.parse(
      formData.get("roundingDirection"),
    );
    const otherCostsFixedCents = parseMoneyField(
      String(formData.get("otherCostsFixed") ?? "0"),
      "Custos fixos por venda",
    );

    await updateDefaultPolicy(getDb(), {
      targetMarginRate,
      minMarginRate,
      roundingMode,
      roundingDirection,
      otherCostsFixedCents,
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return { success: "Política de precificação salva." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Regras de aprovação
// ---------------------------------------------------------------------------

export async function updateApprovalRulesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const threshold = parsePercentField(
      String(formData.get("changeThreshold") ?? ""),
      "Limite de variação",
    );
    const db = getDb();
    await updateSetting(db, {
      key: "price_change_pct_threshold",
      value: threshold,
      userId: user.id,
    });
    await updateSetting(db, {
      key: "first_price_requires_approval",
      value: formData.get("firstPriceRequiresApproval") === "on",
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return { success: "Regras de aprovação salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

export async function updateStockSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const lowStockThreshold = parseIntField(
      String(formData.get("lowStockThreshold") ?? ""),
      "Limiar de estoque baixo",
    );
    const ttlMinutes = parseIntField(
      String(formData.get("reservationTtlMinutes") ?? ""),
      "Tempo de reserva",
    );

    const db = getDb();
    await updateSetting(db, {
      key: "default_low_stock_threshold",
      value: lowStockThreshold,
      userId: user.id,
    });
    await updateSetting(db, {
      key: "stock_reservation_ttl_minutes",
      value: ttlMinutes,
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return { success: "Configurações de estoque salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Mercado Pago — pagamento automático da loja
// ---------------------------------------------------------------------------

export async function updateMercadoPagoAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    await updateSetting(getDb(), {
      key: "mp_enabled",
      value: formData.get("mpEnabled") === "on",
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return {
      success:
        "Configuração do Mercado Pago salva. Sem credenciais, a loja segue no modo manual (WhatsApp/Pix).",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Dados da loja (rodapé e páginas legais — Decreto 7.962/2013)
// ---------------------------------------------------------------------------

/** '11222333000181' -> '11.222.333/0001-81' (formato canônico gravado). */
function formatCnpjBR(digits: string): string {
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
}

export async function updateStoreFactsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const db = getDb();
    const entries: Array<[string, string]> = [
      ["store_hours", String(formData.get("storeHours") ?? "").trim()],
      ["store_pickup", String(formData.get("storePickup") ?? "").trim()],
      // O textarea manda \r\n: normaliza antes de contar e gravar (como a carta de estreia).
      ["store_about", String(formData.get("storeAbout") ?? "").replace(/\r\n?/g, "\n").trim()],
    ];
    for (const [key, value] of entries) {
      await updateSetting(db, { key, value, userId: user.id });
    }
    revalidatePath("/admin/configuracoes");
    return { success: "Ficha salva. A Lia já usa na próxima conversa." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function updateStoreDataAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const name = String(formData.get("storeName") ?? "").trim();
    const cnpjDigits = String(formData.get("storeCnpj") ?? "").replace(/\D/g, "");
    if (cnpjDigits !== "" && !isValidCnpj(cnpjDigits)) {
      return {
        error: "CNPJ inválido. Confira os dígitos, ex.: 11.222.333/0001-81.",
      };
    }
    const cnpj = cnpjDigits === "" ? "" : formatCnpjBR(cnpjDigits);
    const address = String(formData.get("storeAddress") ?? "").trim();
    const email = String(formData.get("storeEmail") ?? "").trim();
    const whatsapp = String(formData.get("storeWhatsapp") ?? "").trim();
    const instagram = String(formData.get("storeInstagram") ?? "").trim();
    const pixKey = String(formData.get("storePixKey") ?? "").trim();

    const db = getDb();
    const entries: Array<[string, string]> = [
      ["store_name", name],
      ["store_cnpj", cnpj],
      ["store_address", address],
      ["store_email", email],
      // O serviço normaliza o WhatsApp para E.164 (+55…) quando não vazio.
      ["store_whatsapp", whatsapp],
      // O serviço normaliza para '@usuario'; vazio = o perfil padrão da marca.
      ["store_instagram", instagram],
      // Vazio = Pix manual desligado (robô e página do pedido não oferecem).
      ["store_pix_key", pixKey],
    ];
    for (const [key, value] of entries) {
      await updateSetting(db, { key, value, userId: user.id });
    }

    revalidatePath("/admin/configuracoes");
    return { success: "Dados da loja salvos. Eles já aparecem no rodapé da loja." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Carta de estreia — a primeira compra ganha uma carta assinada pela dona
// ---------------------------------------------------------------------------

export async function updateDebutLetterAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    // O navegador manda CRLF no textarea: normaliza antes de contar e de salvar.
    const text = String(formData.get("debutLetterText") ?? "").replace(/\r\n?/g, "\n").trim();
    const signature = String(formData.get("debutLetterSignature") ?? "").trim();
    const db = getDb();
    // Vazio = a carta não sai (o serviço aceita vazio).
    await updateSetting(db, { key: "debut_letter_text", value: text, userId: user.id });
    await updateSetting(db, { key: "debut_letter_signature", value: signature, userId: user.id });
    revalidatePath("/admin/configuracoes");
    return {
      success:
        text === ""
          ? "Carta de estreia desligada: nenhuma carta sai na caixa."
          : "Carta de estreia salva. Ela entra nos cartões dos próximos pedidos de primeira compra (nos já gerados, toque em “Gerar de novo”).",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Vitrine — textos da home (frase do hero e manifesto)
// ---------------------------------------------------------------------------

export async function updateStorefrontAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const tagline = String(formData.get("storeTagline") ?? "").trim();
    const manifesto = String(formData.get("storeManifesto") ?? "").trim();
    const edition = String(formData.get("editionName") ?? "").trim();

    const db = getDb();
    // Vazio = a home volta ao texto padrão (o serviço aceita vazio).
    await updateSetting(db, { key: "store_tagline", value: tagline, userId: user.id });
    await updateSetting(db, { key: "store_manifesto", value: manifesto, userId: user.id });
    await updateSetting(db, { key: "edition_name", value: edition, userId: user.id });

    revalidatePath("/admin/configuracoes");
    // A home é ISR (5 min): revalidar aqui é o que faz o dono ver na hora.
    revalidatePath("/");
    return { success: "Textos da vitrine salvos. Abra a home para conferir." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Datas da cidade: linhas nome + dia; em branco é ignorada; a ordem é a das datas. */
export async function updateCityDatesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const dates: { name: string; date: string }[] = [];
    for (let index = 0; index < 12; index += 1) {
      const name = String(formData.get(`city_date_${index}_name`) ?? "").trim();
      const date = String(formData.get(`city_date_${index}_date`) ?? "").trim();
      if (!name && !date) continue;
      if (!name || !date) throw new ServiceError("data_incompleta", `Linha ${index + 1}: informe o nome e o dia.`);
      dates.push({ name, date });
    }
    dates.sort((a, b) => a.date.localeCompare(b.date));
    await updateSetting(getDb(), { key: "city_dates", value: dates, userId: user.id });
    revalidatePath("/admin/configuracoes");
    revalidatePath("/", "layout");
    return { success: dates.length === 0 ? "Sem datas da cidade: o selo da vitrine fica desligado." : `${dates.length} ${dates.length === 1 ? "data salva" : "datas salvas"}. A vitrine mostra a próxima.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Foto no corpo — cota, qualidade e combinação padrão
// ---------------------------------------------------------------------------

export async function updateStudioSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("configuracoes");
  try {
    const dailyQuota = parseIntField(String(formData.get("dailyQuota") ?? ""), "Imagens por dia");
    const db = getDb();
    await updateSetting(db, { key: "ai_photos_daily_quota", value: dailyQuota, userId: user.id });
    await updateSetting(db, { key: "ai_photos_quality", value: String(formData.get("quality") ?? ""), userId: user.id });
    await updateSetting(db, { key: "ai_photos_default_scene", value: String(formData.get("defaultScene") ?? ""), userId: user.id });
    await updateSetting(db, { key: "ai_photos_default_model", value: String(formData.get("defaultModel") ?? ""), userId: user.id });
    revalidatePath("/admin/configuracoes");
    return { success: "Foto no corpo salva." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
