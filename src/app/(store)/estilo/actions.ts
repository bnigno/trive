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

const saveSchema = z.object({
  profile: styleProfileSchema,
  phone: z.string().trim().min(8, "Informe o seu WhatsApp."),
  consent: z.literal(true, { error: "Marque a caixinha para guardar a cartela." }),
  website: z.string().max(0).optional(),
});

export type SaveStyleResult =
  | { ok: true; token: string; paletteName: string }
  | { ok: false; message: string };

export async function saveStyleProfileAction(input: unknown): Promise<SaveStyleResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Confira os dados." };
  if (parsed.data.website) return { ok: false, message: "Não deu para guardar agora." };
  const phoneE164 = toE164BR(parsed.data.phone);
  if (!phoneE164) return { ok: false, message: "Informe um WhatsApp válido com DDD." };
  try {
    const saved = await saveStyleProfile(getDb(), {
      phoneE164,
      patch: parsed.data.profile,
      source: "quiz",
      consent: true,
    });
    return { ok: true, token: saved.siteToken, paletteName: saved.paletteName };
  } catch (error) {
    console.error("saveStyleProfileAction", error);
    return { ok: false, message: "Não deu para guardar agora. Tente de novo em instantes." };
  }
}

export interface SavedStyleView {
  paletteName: string;
  profile: StyleProfile;
  items: EditionItemView[];
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
