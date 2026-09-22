"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { PIECE_TYPE_SLUGS, type PieceType } from "@/core/catalog/piece-types";
import { getDb } from "@/db/client";
import { getFileStorage } from "@/adapters/storage";
import { getTranscriber } from "@/adapters/transcription";
import {
  recordCuratorNote,
  removeCuratorAudio,
  updateCuratorNote,
  type CuratorNoteResult,
} from "@/services/curator-notes";
import { CURATOR_NOTE_MAX_CHARS, resolveCuratorAudioFormat } from "@/core/catalog/curator-note";
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
import { BODY_SIZE_KEYS, HOUSE_MODEL_KEYS, SCENE_KEYS, STUDIO_QUALITIES } from "@/core/studio/presets";
import {
  chooseStudioCandidate,
  discardStudioCandidate,
  requestStudioPhotos,
  ServiceError as StudioServiceError,
} from "@/services/studio";

export type FormState = { error?: string; success?: string };

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError || error instanceof StudioServiceError) return { error: error.message };
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
  const pieceTypeRaw = String(formData.get("pieceType") ?? "").trim();
  const pieceType = (PIECE_TYPE_SLUGS as readonly string[]).includes(pieceTypeRaw) ? (pieceTypeRaw as PieceType) : null;
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
      pieceType,
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

/** O que a tela mostra depois de gravar: além de erro/sucesso, se o texto veio. */
export type CuratorNoteFormState = FormState & {
  /** A transcrição preencheu o texto; a gravação pendente pode ser descartada. */
  transcribed?: boolean;
  /** Reenviar o mesmo áudio pode dar certo (serviço instável ou cota): a gravação fica na tela. */
  retryable?: boolean;
  /** O áudio ficou salvo, mas sem texto: é um aviso, não um sucesso. */
  warning?: string;
};

export async function recordCuratorNoteAction(
  _prev: CuratorNoteFormState,
  formData: FormData,
): Promise<CuratorNoteFormState> {
  const user = await requireOwner("produtos");
  try {
    const productId = String(formData.get("productId") ?? "");
    const file = formData.get("audio");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Grave a nota ou escolha um arquivo de áudio." };
    }
    // O Android às vezes manda o m4a como application/octet-stream: vale o nome.
    const format = resolveCuratorAudioFormat(file.type, file.name);
    if (!format) {
      return {
        error: "Não reconheci esse formato de áudio. Grave pelo botão da tela ou envie um arquivo comum (m4a, mp3, ogg).",
      };
    }
    const secondsRaw = Number(formData.get("seconds") ?? 0);
    const result = await recordCuratorNote(getDb(), getFileStorage(), getTranscriber(), {
      productId,
      userId: user.id,
      audio: {
        data: Buffer.from(await file.arrayBuffer()),
        contentType: format.mime,
        originalContentType: file.type || `(sem mime; nome ${file.name})`,
        ...(Number.isFinite(secondsRaw) && secondsRaw > 0
          ? { seconds: Math.round(secondsRaw) }
          : {}),
      },
    });
    revalidateProduct(productId);
    const message = curatorNoteMessage(result);
    const retryable = result.reason === "unavailable" || result.reason === "rate_limited";
    return result.transcribed
      ? { success: message, transcribed: true, retryable: false }
      : { warning: message, transcribed: false, retryable };
  } catch (error) {
    return toErrorState(error);
  }
}

/** A frase certa para cada desfecho — a dona precisa saber o que fazer, não o que falhou. */
function curatorNoteMessage(result: CuratorNoteResult): string {
  const stale = result.staleNote ? " O texto abaixo é o da gravação anterior — confira." : "";
  switch (result.reason) {
    case "ok":
      return result.truncated
        ? `Transcrevi, mas a fala passou de ${CURATOR_NOTE_MAX_CHARS} caracteres e o final foi cortado — complete à mão.`
        : "Nota gravada e transcrita — confira o texto e ajuste se precisar.";
    case "empty":
      return `Áudio guardado, mas não ouvi fala nele — ouça a gravação e grave de novo, mais perto do microfone.${stale}`;
    case "no_key":
      return `Áudio guardado. A transcrição automática está desligada (falta a chave da OpenAI na hospedagem): escreva a nota à mão.${stale}`;
    case "rejected":
      return `Áudio guardado, mas o transcritor recusou esse arquivo. Grave pelo botão da tela ou escreva à mão.${stale}`;
    default:
      return `Áudio guardado. Não consegui transcrever agora (o serviço está instável): toque em Enviar de novo daqui a pouco, ou escreva à mão.${stale}`;
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

// ---------------------------------------------------------------------------
// Foto no corpo (ensaio)
// ---------------------------------------------------------------------------

const requestStudioSchema = z.object({
  productId: z.uuid("Não foi possível identificar este produto."),
  color: z.string().trim().optional(),
  sceneKey: z.enum(SCENE_KEYS, { error: "Cena desconhecida." }),
  modelKey: z.enum(HOUSE_MODEL_KEYS, { error: "Modelo desconhecido." }),
  sizeKey: z.enum(BODY_SIZE_KEYS, { error: "Corpo desconhecido." }),
  quality: z.enum(STUDIO_QUALITIES, { error: "Qualidade inválida." }),
  options: z.coerce.number().int().min(1).max(4),
});

export async function requestStudioPhotosAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("produtos");
  const parsed = requestStudioSchema.safeParse({
    productId: String(formData.get("productId") ?? ""),
    color: formData.get("color") == null ? undefined : String(formData.get("color")),
    sceneKey: String(formData.get("sceneKey") ?? ""),
    modelKey: String(formData.get("modelKey") ?? ""),
    sizeKey: String(formData.get("sizeKey") ?? ""),
    quality: String(formData.get("quality") ?? ""),
    options: String(formData.get("options") ?? "3"),
  });
  if (!parsed.success) return toErrorState(parsed.error);
  try {
    const created = await requestStudioPhotos(getDb(), {
      productId: parsed.data.productId,
      color: parsed.data.color ? parsed.data.color : null,
      sceneKey: parsed.data.sceneKey,
      modelKey: parsed.data.modelKey,
      sizeKey: parsed.data.sizeKey,
      quality: parsed.data.quality,
      options: parsed.data.options,
      userId: user.id,
      source: "admin",
    });
    revalidatePath(`/admin/produtos/${parsed.data.productId}`);
    return { success: `${created.eventIds.length === 1 ? "1 opção" : `${created.eventIds.length} opções`} na fila — cada uma leva perto de meio minuto. Recarregue a página para ver.` };
  } catch (error) {
    return toErrorState(error);
  }
}

const candidateSchema = z.object({
  candidateId: z.uuid("Não foi possível identificar esta opção."),
  productId: z.uuid("Não foi possível identificar este produto."),
});

export async function chooseStudioCandidateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("produtos");
  const parsed = candidateSchema.safeParse({ candidateId: String(formData.get("candidateId") ?? ""), productId: String(formData.get("productId") ?? "") });
  if (!parsed.success) return toErrorState(parsed.error);
  try {
    await chooseStudioCandidate(getDb(), getFileStorage(), { candidateId: parsed.data.candidateId, userId: user.id });
  } catch (error) {
    return toErrorState(error);
  }
  revalidateProduct(parsed.data.productId);
  return { success: "Guardada como foto da peça (depois das reais)." };
}

export async function discardStudioCandidateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("produtos");
  const parsed = candidateSchema.safeParse({ candidateId: String(formData.get("candidateId") ?? ""), productId: String(formData.get("productId") ?? "") });
  if (!parsed.success) return toErrorState(parsed.error);
  try {
    await discardStudioCandidate(getDb(), { candidateId: parsed.data.candidateId, userId: user.id });
  } catch (error) {
    return toErrorState(error);
  }
  revalidatePath(`/admin/produtos/${parsed.data.productId}`);
  return { success: "Descartada." };
}
