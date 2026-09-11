"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getDb } from "@/db/client";
import { getFileStorage } from "@/adapters/storage";
import { getTranscriber } from "@/adapters/transcription";
import {
  recordCuratorNote,
  removeCuratorAudio,
  updateCuratorNote,
} from "@/services/curator-notes";
import { requireOwner } from "@/services/auth";
import {
  addProductImage,
  addVariant,
  removeProductImage,
  ServiceError,
  setProductImageColor,
  setProductMeasurementsBySize,
  updateProduct,
  updateVariant,
} from "@/services/catalog";
import { CARE_SYMBOL_KEYS, formatCareNotes } from "@/core/catalog/care";
import { MEASUREMENT_KEYS, type Measurements } from "@/core/catalog/measurements";

export type FormState = { error?: string; success?: string };

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

function revalidateProduct(productId: string): void {
  revalidatePath("/admin/produtos");
  revalidatePath(`/admin/produtos/${productId}`);
  // A vitrine tem ISR de 5 min: nome e código novos precisam chegar à loja
  // na hora (a home lista peças, a coleção e a página da peça mostram o Cód.).
  revalidatePath("/");
  revalidatePath("/produtos");
  // A tag da página leva o grupo de rota: sem "(store)" nada é invalidado.
  revalidatePath("/(store)/produto/[slug]", "page");
}

/** Reconstrói atributos a partir de inputs nomeados "attr:<eixo>". */
function attributesFromForm(formData: FormData): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("attr:") && typeof value === "string") {
      attributes[key.slice("attr:".length)] = value.trim();
    }
  }
  return attributes;
}

// ---------------------------------------------------------------------------
// Dados básicos e status
// ---------------------------------------------------------------------------

export async function updateProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Informe o nome do produto." };
  const currentName = String(formData.get("currentName") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const axes = String(formData.get("axes") ?? "")
    .split(",")
    .map((axis) => axis.trim())
    .filter(Boolean);
  // Ficha da peça: pictogramas marcados + linhas livres viram um texto só.
  const composition = String(formData.get("composition") ?? "").trim();
  const careSymbols = CARE_SYMBOL_KEYS.filter((key) => formData.get(`care:${key}`) === "on");
  const careText = String(formData.get("careText") ?? "").split("\n");
  const careNotes = formatCareNotes(careSymbols, careText);
  const fitNotes = String(formData.get("fitNotes") ?? "").trim();

  try {
    const db = getDb();
    await updateProduct(db, {
      productId,
      userId: user.id,
      name,
      description: description || null,
      composition: composition || null,
      careNotes,
      fitNotes: fitNotes || null,
      brand: brand || null,
      categoryId: categoryId || null,
      supplierId: supplierId || null,
      attributesSchema: axes,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  if (currentName && currentName !== name) {
    // A dúvida nasce aqui: o nome mudou e os códigos ficaram. Dizer na hora.
    return {
      success:
        "Produto atualizado. Os códigos (SKU) das variações continuam os mesmos — ajuste em “Editar variações”, se quiser.",
    };
  }
  return { success: "Produto atualizado." };
}

export async function setProductStatusAction(
  formData: FormData,
): Promise<void> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "draft" && status !== "active" && status !== "archived") {
    return;
  }

  try {
    const db = getDb();
    await updateProduct(db, { productId, userId: user.id, status });
  } catch {
    // Sem estado de formulário aqui: em caso de erro a tela apenas não muda.
    return;
  }

  revalidateProduct(productId);
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

export async function uploadImagesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");

  const files = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length === 0) {
    return { error: "Selecione ao menos uma imagem." };
  }

  // Cor a que as fotos deste envio pertencem; ausente = fotos do produto
  // inteiro. Quem não manda o campo (o uploader da tela do produto) segue
  // gravando color nulo, como antes.
  const color = String(formData.get("color") ?? "").trim();

  const db = getDb();
  const storage = getFileStorage();
  let uploaded = 0;
  try {
    for (const file of files) {
      const data = Buffer.from(await file.arrayBuffer());
      await addProductImage(db, storage, {
        productId,
        data,
        contentType: file.type || "application/octet-stream",
        color: color || undefined,
        userId: user.id,
      });
      uploaded += 1;
    }
  } catch (error) {
    revalidateProduct(productId);
    const base = toErrorState(error);
    return uploaded > 0
      ? {
          error: `${base.error} (${uploaded} de ${files.length} imagens foram enviadas antes do erro.)`,
        }
      : base;
  }

  revalidateProduct(productId);
  return {
    success:
      uploaded === 1 ? "1 imagem enviada." : `${uploaded} imagens enviadas.`,
  };
}

export async function removeImageAction(formData: FormData): Promise<void> {
  const user = await requireOwner("produtos");
  const imageId = String(formData.get("imageId") ?? "");
  const productId = String(formData.get("productId") ?? "");

  try {
    const db = getDb();
    const storage = getFileStorage();
    await removeProductImage(db, storage, { imageId, userId: user.id });
  } catch {
    return;
  }

  revalidateProduct(productId);
}

const setImageColorSchema = z.object({
  imageId: z.uuid("Não foi possível identificar esta foto."),
  productId: z.uuid("Não foi possível identificar este produto."),
  // Campo vazio no seletor = foto do produto inteiro (cor nula).
  color: z.string().trim(),
});

export async function setImageColorAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");

  const parsed = setImageColorSchema.safeParse({
    imageId: String(formData.get("imageId") ?? ""),
    productId: String(formData.get("productId") ?? ""),
    color: String(formData.get("color") ?? ""),
  });
  if (!parsed.success) return toErrorState(parsed.error);

  let savedColor: string | null;
  try {
    const db = getDb();
    const image = await setProductImageColor(db, {
      imageId: parsed.data.imageId,
      color: parsed.data.color || null,
      userId: user.id,
    });
    savedColor = image.color;
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(parsed.data.productId);
  return {
    success: savedColor
      ? `Foto marcada como "${savedColor}".`
      : "Foto marcada como do produto inteiro.",
  };
}

// ---------------------------------------------------------------------------
// Variações
// ---------------------------------------------------------------------------

export async function addVariantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const sku = String(formData.get("sku") ?? "").trim();
  if (!sku) return { error: "Informe o SKU da variação." };

  const attributes = attributesFromForm(formData);
  for (const [axis, value] of Object.entries(attributes)) {
    if (!value) return { error: `Preencha o campo "${axis}".` };
  }

  let created: { sku: string };
  try {
    const db = getDb();
    created = await addVariant(db, { productId, userId: user.id, sku, attributes });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  return {
    success: `Variação "${created.sku}" criada. Defina o custo e o preço na calculadora de preços.`,
  };
}

export async function updateVariantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const variantId = String(formData.get("variantId") ?? "");
  const currentSku = String(formData.get("currentSku") ?? "");
  const typedSku = String(formData.get("sku") ?? "").trim();

  const attributes = attributesFromForm(formData);
  for (const [axis, value] of Object.entries(attributes)) {
    if (!value) return { error: `Preencha o campo "${axis}".` };
  }

  // Peso em gramas: vazio mantém o que está; o frete por faixa depende dele.
  const weightRaw = String(formData.get("weightGrams") ?? "").trim();
  let weightGrams: number | undefined;
  if (weightRaw !== "") {
    const parsedWeight = Number(weightRaw);
    if (!Number.isInteger(parsedWeight) || parsedWeight <= 0) {
      return { error: "Peso em gramas: use um número inteiro maior que zero." };
    }
    weightGrams = parsedWeight;
  }

  // O código só viaja quando o dono mexeu nele (o service normaliza e valida).
  const skuChanged = typedSku !== "" && typedSku !== currentSku;
  let updated: { sku: string };
  try {
    const db = getDb();
    updated = await updateVariant(db, {
      variantId,
      userId: user.id,
      attributes,
      ...(weightGrams !== undefined ? { weightGrams } : {}),
      ...(skuChanged ? { sku: typedSku } : {}),
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  if (skuChanged && updated.sku !== currentSku) {
    return { success: `Código alterado de ${currentSku} para ${updated.sku}.` };
  }
  return { success: "Variação atualizada." };
}

// ---------------------------------------------------------------------------
// Fita métrica
// ---------------------------------------------------------------------------

export async function setProductMeasurementsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const sizes = String(formData.get("sizes") ?? "")
    .split("\n")
    .map((size) => size.trim())
    .filter(Boolean);

  const bySize: Record<string, Measurements> = {};
  for (const size of sizes) {
    const measurements: Measurements = {};
    for (const key of MEASUREMENT_KEYS) {
      const raw = String(formData.get(`m:${size}:${key}`) ?? "").trim().replace(",", ".");
      if (raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return { error: `Medida inválida em ${size}: use números em centímetros.` };
      }
      measurements[key] = value;
    }
    bySize[size] = measurements;
  }

  let result: { updated: number; unknownSizes: string[] };
  try {
    const db = getDb();
    result = await setProductMeasurementsBySize(db, { productId, userId: user.id, bySize });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  return {
    success:
      result.updated === 0
        ? "Nada mudou na fita métrica."
        : `Fita métrica salva em ${result.updated} ${result.updated === 1 ? "variação" : "variações"}.`,
  };
}

// ---------------------------------------------------------------------------
// A nota da curadora: a voz da dona sobre a peça
// ---------------------------------------------------------------------------

export async function recordCuratorNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  try {
    const productId = String(formData.get("productId") ?? "");
    const file = formData.get("audio");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Grave a nota ou escolha um arquivo de áudio." };
    }
    const secondsRaw = Number(formData.get("seconds") ?? 0);
    const result = await recordCuratorNote(getDb(), getFileStorage(), getTranscriber(), {
      productId,
      userId: user.id,
      audio: {
        data: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "audio/webm",
        ...(Number.isFinite(secondsRaw) && secondsRaw > 0
          ? { seconds: Math.round(secondsRaw) }
          : {}),
      },
    });
    revalidateProduct(productId);
    return {
      success: result.transcribed
        ? "Nota gravada e transcrita — confira o texto e ajuste se precisar."
        : "Áudio guardado. Não consegui transcrever agora: escreva a nota à mão.",
    };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function updateCuratorNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  try {
    const productId = String(formData.get("productId") ?? "");
    await updateCuratorNote(getDb(), {
      productId,
      userId: user.id,
      note: String(formData.get("note") ?? ""),
    });
    revalidateProduct(productId);
    return { success: "Nota da curadora salva." };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function removeCuratorAudioAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  try {
    const productId = String(formData.get("productId") ?? "");
    const { removed } = await removeCuratorAudio(getDb(), getFileStorage(), {
      productId,
      userId: user.id,
    });
    revalidateProduct(productId);
    return { success: removed ? "Áudio removido; o texto continua." : "Esta peça não tem áudio." };
  } catch (error) {
    return toErrorState(error);
  }
}
