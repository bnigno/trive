// O "prompt de fotografia" da casa é FIXO e vive aqui: realismo é regra, não
// enfeite. A foto-base da modela nasce deste texto + cena + modela + corpo;
// a peça entra depois, por try-on, sem redesenhar a estampa. PURO.
import type { PieceType } from "@/core/catalog/piece-types";

import { bodySizeByKey, houseModelByKey, sceneByKey } from "./presets";

/**
 * Como a foto tem de parecer: foto boa de celular numa tarde em Belém. A
 * modela veste básicos neutros e justos para o try-on poder trocar blusa,
 * parte de baixo ou peça inteira depois.
 */
export const PHOTOGRAPHY_PROMPT =
  "Photorealistic candid photo taken with a phone camera, natural light only, real skin texture with visible pores and a little shine, a few loose flyaway hairs, natural fabric wrinkles, background with depth and everyday imperfection, eye-level 35mm-equivalent framing, three-quarter body shot standing naturally with arms relaxed, subtle film grain, slightly muted colors. She wears a plain light-grey fitted tank top and plain fitted mid-thigh shorts, simple flat sandals.";

/** O que NÃO pode aparecer — o gerador recebe isto como instrução negativa. */
export const NEGATIVE_PROMPT =
  "plastic skin, airbrushed face, perfect symmetry, studio grey backdrop, professional fashion campaign look, extra or deformed hands or fingers, text, logos, watermark, jewelry covering the neckline, hat, sunglasses, bag, coat";

export type ModelPhotoPromptInput = {
  modelKey: string;
  sceneKey: string;
  sizeKey: string;
};

/**
 * Texto completo da foto-base: quem, com que corpo, onde, e a regra da casa.
 * Chave desconhecida é erro de programação (as listas são fechadas).
 */
export function buildModelPhotoPrompt(input: ModelPhotoPromptInput): string {
  const model = houseModelByKey(input.modelKey);
  const scene = sceneByKey(input.sceneKey);
  const size = bodySizeByKey(input.sizeKey);
  if (!model || !scene || !size) {
    throw new Error(`Preset desconhecido: modela=${input.modelKey} cena=${input.sceneKey} tamanho=${input.sizeKey}`);
  }
  return `${model.prompt}, ${size.prompt}, ${scene.prompt}. ${PHOTOGRAPHY_PROMPT} Avoid: ${NEGATIVE_PROMPT}.`;
}

/** Cena resumida para o try-on de qualidade alta (que aceita um prompt curto). */
export function buildScenePrompt(sceneKey: string): string {
  const scene = sceneByKey(sceneKey);
  if (!scene) throw new Error(`Cena desconhecida: ${sceneKey}`);
  return `Keep the same person, pose and setting: ${scene.prompt}. Natural light, real skin texture, subtle film grain.`;
}

export type StudioGarmentCategory = "tops" | "bottoms" | "one-pieces";

/**
 * O try-on precisa saber se troca a parte de cima, a de baixo ou a peça
 * inteira. Acessórios não têm ensaio (null): não há o que vestir.
 */
export function garmentCategoryFor(pieceType: PieceType | null): StudioGarmentCategory | null {
  switch (pieceType) {
    case "vestido":
    case "macacao":
    case "conjunto":
      return "one-pieces";
    case "blusa":
    case "cropped":
    case "top":
    case "body":
    case "corset":
    case "camisa":
    case "kimono":
    case "casaco":
      return "tops";
    case "saia":
    case "calca":
    case "short":
    case "bermuda":
      return "bottoms";
    default:
      return null;
  }
}
