// O "prompt de fotografia" da casa é FIXO e vive aqui. A TRIVÉ é uma maison:
// a foto tem de parecer campanha de moda, não retrato casual — mas fotografia
// de verdade, nunca aquele acabamento plástico de IA. A foto-base da modelo
// nasce deste texto + cena + modelo + corpo; a peça entra depois, por try-on,
// sem redesenhar a estampa. PURO.
import type { PieceType } from "@/core/catalog/piece-types";

import { bodySizeByKey, houseModelByKey, sceneByKey } from "./presets";

/**
 * Como a foto tem de parecer: editorial de moda, com luz desenhada e acabamento
 * de catálogo de grife. "Pele real, levemente retocada" segura o realismo sem
 * devolver a estética de foto de celular. A modelo veste básicos neutros e
 * justos para o try-on poder trocar blusa, parte de baixo ou peça inteira.
 */
export const PHOTOGRAPHY_PROMPT =
  "Photorealistic professional fashion editorial photograph, shot on a full-frame camera with an 85mm portrait lens at f/2, large soft key light with gentle falloff and a delicate rim light separating her from the background, real skin texture lightly retouched to a clean finish, hair styled and smooth, elegant three-quarter body shot standing tall with relaxed shoulders and a poised composed expression, refined colour with deep blacks, luxury e-commerce campaign quality. She wears well-fitted plain light-grey basics — a simple tank top and mid-thigh shorts — with simple flat sandals.";

/** O que NÃO pode aparecer — o gerador recebe isto como instrução negativa. */
export const NEGATIVE_PROMPT =
  "plastic or waxy skin, heavy airbrushing, harsh direct flash, amateur snapshot look, cluttered or busy background, oversaturated colours, extra or deformed hands or fingers, text, logos, watermark, jewelry covering the neckline, hat, sunglasses, bag, coat";

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
    throw new Error(`Preset desconhecido: modelo=${input.modelKey} cena=${input.sceneKey} tamanho=${input.sizeKey}`);
  }
  return `${model.prompt}, ${size.prompt}, ${scene.prompt}. ${PHOTOGRAPHY_PROMPT} Avoid: ${NEGATIVE_PROMPT}.`;
}

/** Cena resumida para o try-on de qualidade alta (que aceita um prompt curto). */
export function buildScenePrompt(sceneKey: string): string {
  const scene = sceneByKey(sceneKey);
  if (!scene) throw new Error(`Cena desconhecida: ${sceneKey}`);
  return `Keep the same person, pose and setting: ${scene.prompt}. Soft editorial lighting, real skin texture, refined campaign finish.`;
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
