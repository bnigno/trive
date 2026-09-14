"use server";
// A cartela de estilo na vitrine: curar a edição a partir das respostas do
// quiz, guardar a cartela (telefone + consentimento explícito → token do
// navegador), reler pelo token e esquecer. Sem login: telefone é a identidade.
import { z } from "zod";

import { getDb } from "@/db/client";
import { paletteName, styleProfileSchema, type StyleProfile } from "@/core/style/profile";
import { toE164BR } from "@/lib/phone";
import { publicMdUrl } from "@/services/store-catalog";
import {
  curateEditionForProfile,
  forgetStyleProfile,
  getStyleProfileByToken,
  saveStyleProfile,
  forgetBodyMeasurements,
  saveBodyMeasurements,
} from "@/services/style-profiles";

export interface EditionItemView {
  slug: string;
  name: string;
  priceFromCents: number;
  priceToCents: number;
  imageUrl: string | null;
  reasons: string[];
}

async function editionFor(profile: StyleProfile): Promise<EditionItemView[]> {
  const items = await curateEditionForProfile(getDb(), profile, { limit: 3 });
  return items.map(({ product, reasons }) => {
    let imageUrl: string | null = null;
    if (product.imagePath) {
      try {
        imageUrl = publicMdUrl(product.imagePath);
      } catch {
        imageUrl = null;
      }
    }
    return {
      slug: product.slug,
      name: product.name,
      priceFromCents: product.priceFromCents,
      priceToCents: product.priceToCents,
      imageUrl,
      reasons,
    };
  });
}

export async function curateEditionAction(input: unknown): Promise<{ items: EditionItemView[] }> {
  const parsed = styleProfileSchema.safeParse(input);
  if (!parsed.success) return { items: [] };
  try {
    return { items: await editionFor(parsed.data) };
  } catch (error) {
    console.error("curateEditionAction", error);
    return { items: [] };
  }
}

const bodyCm = z.coerce.number().min(40, "Medida em cm, entre 40 e 200.").max(200, "Medida em cm, entre 40 e 200.");
const saveSchema = z.object({
  profile: styleProfileSchema,
  phone: z.string().trim().min(8, "Informe o seu WhatsApp."),
  consent: z.literal(true, { error: "Marque a caixinha para guardar a cartela." }),
  website: z.string().max(0).optional(),
  /** Último passo do quiz, opcional: busto/cintura/quadril em cm (strings vazias já removidas). */
  body: z.object({ bustCm: bodyCm.optional(), waistCm: bodyCm.optional(), hipsCm: bodyCm.optional() }).optional(),
});

export type SaveStyleResult =
  | { ok: true; token: string; paletteName: string; bodyToken: string | null; bodyNote: string | null }
  | { ok: false; message: string };

export async function saveStyleProfileAction(input: unknown): Promise<SaveStyleResult> {
  const cleaned =
    typeof input === "object" && input !== null && "body" in input && typeof (input as { body?: unknown }).body === "object" && (input as { body?: unknown }).body !== null
      ? { ...(input as Record<string, unknown>), body: Object.fromEntries(Object.entries((input as { body: Record<string, unknown> }).body).filter(([, value]) => value !== "" && value !== undefined && value !== null)) }
      : input;
  const parsed = saveSchema.safeParse(cleaned);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Confira os dados." };
  if (parsed.data.website) return { ok: false, message: "Não deu para guardar agora." };
  const phoneE164 = toE164BR(parsed.data.phone);
  if (!phoneE164) return { ok: false, message: "Informe um WhatsApp válido com DDD." };
  try {
    const db = getDb();
    const saved = await saveStyleProfile(db, {
      phoneE164,
      patch: parsed.data.profile,
      source: "quiz",
      consent: true,
    });
    // As medidas vão para a coluna própria; se já havia medidas em outro
    // aparelho, ficam como estão (a credencial delas não está aqui).
    let bodyToken: string | null = null;
    let bodyNote: string | null = null;
    const body = parsed.data.body ?? {};
    if (Object.keys(body).length > 0) {
      const result = await saveBodyMeasurements(db, { siteToken: saved.siteToken, body });
      if (result.saved) bodyToken = result.bodyToken;
      else if (result.reason === "sem_credencial") bodyNote = "Suas medidas já estavam guardadas em outro aparelho e ficaram como estão — para trocar, peça à vendedora no WhatsApp.";
    }
    return { ok: true, token: saved.siteToken, paletteName: saved.paletteName, bodyToken, bodyNote };
  } catch (error) {
    console.error("saveStyleProfileAction", error instanceof Error ? error.name : "erro");
    return { ok: false, message: "Não deu para guardar agora. Tente de novo em instantes." };
  }
}

/** "Apagar minhas medidas" na tela da cartela: só com a credencial deste navegador. */
export async function forgetBodyMeasurementsFromQuizAction(input: { token: string; bodyToken: string }): Promise<{ ok: boolean }> {
  const parsed = z.object({ token: z.uuid(), bodyToken: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const { forgotten } = await forgetBodyMeasurements(getDb(), { siteToken: parsed.data.token, bodyToken: parsed.data.bodyToken });
    return { ok: forgotten };
  } catch (error) {
    console.error("forgetBodyMeasurementsFromQuizAction", error instanceof Error ? error.name : "erro");
    return { ok: false };
  }
}

export interface SavedStyleView {
  paletteName: string;
  profile: StyleProfile;
  items: EditionItemView[];
  /** Só o fato: as medidas existem na cartela (os números nunca voltam). */
  hasBody: boolean;
}

/** Cartela do navegador (token) + a edição de hoje; null quando não existe mais. */
export async function editionForTokenAction(token: string): Promise<SavedStyleView | null> {
  try {
    const saved = await getStyleProfileByToken(getDb(), token);
    if (!saved) return null;
    return {
      paletteName: saved.paletteName || paletteName(saved.profile),
      profile: saved.profile,
      items: await editionFor(saved.profile),
      hasBody: saved.hasBodyMeasurements,
    };
  } catch (error) {
    console.error("editionForTokenAction", error);
    return null;
  }
}

export async function forgetStyleProfileAction(token: string): Promise<{ forgotten: boolean }> {
  try {
    return await forgetStyleProfile(getDb(), { siteToken: token });
  } catch (error) {
    console.error("forgetStyleProfileAction", error);
    return { forgotten: false };
  }
}
