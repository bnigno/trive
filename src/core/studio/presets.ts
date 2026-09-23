// A casa do ensaio: cenas, modelos e corpos são listas FIXAS em código — a
// mesma modelo, na mesma cena, em toda a edição é o que dá consistência de
// marca ao feed. PURO: sem I/O. Os textos em inglês são prompts para o
// gerador de imagem (respondem melhor); os rótulos, em português, são o que
// a dona vê no painel.
//
// Nenhuma modelo é parecida com pessoa real, e nunca se usa rosto ou corpo
// de cliente. O perfil das três é decisão da dona: mudar aqui é uma linha.

export const SCENE_PRESETS = [
  {
    key: "varanda_16h",
    label: "Varanda às 16h",
    description: "Varanda de apartamento em Belém, sol das 16h rasgando a parede, planta e cadeira desfocadas.",
    prompt:
      "on a tiled apartment balcony in Belém do Pará in the late afternoon, warm 4pm sunlight raking across the wall, a potted plant and part of a wooden chair out of focus, the city hazy in the distance",
  },
  {
    key: "azulejo",
    label: "Parede de azulejo",
    description: "Parede de azulejo português do centro histórico, um pouco gasta, sombra com luz rebatida.",
    prompt:
      "standing in front of an old Portuguese azulejo tile wall in the historic center of Belém, blue-and-white patterned tiles slightly worn and chipped, soft shade with bounced daylight",
  },
  {
    key: "calcada_chuva",
    label: "Calçada depois da chuva",
    description: "Calçada molhada logo depois da chuva da tarde, mangueiras, poças refletindo o céu, luz difusa.",
    prompt:
      "on a wet sidewalk right after the afternoon rain in Belém, mango trees overhead, puddles reflecting the sky, overcast soft light, a colonial facade blurred in the background",
  },
  {
    key: "sala_clara",
    label: "Sala clara",
    description: "Sala branca com janela grande e cortina leve, luz lateral, cadeira de palhinha e planta.",
    prompt:
      "in a bright living room with white walls and a large window with sheer curtains, daylight from the side, a rattan chair and a plant partly visible, calm and simple",
  },
  {
    key: "estudio",
    label: "Estúdio",
    description: "Fundo infinito neutro e luz de campanha: nada disputa com a peça. É a cena mais próxima de catálogo de grife.",
    prompt:
      "in a professional photography studio against a seamless warm greige backdrop, large soft key light from the side with gentle falloff and a subtle shadow at the feet, clean editorial campaign lighting, no props and nothing else in the frame",
  },
] as const;

export type SceneKey = (typeof SCENE_PRESETS)[number]["key"];
export const SCENE_KEYS = SCENE_PRESETS.map((scene) => scene.key) as [SceneKey, ...SceneKey[]];

export const HOUSE_MODELS = [
  {
    key: "modelo_a",
    label: "Modelo A",
    description: "Modelo profissional de uns 27 anos, pele clara, cabelo castanho-escuro liso e brilhante na altura dos ombros. Porte de campanha.",
    prompt:
      "a professional high-fashion editorial model in her late twenties, fair skin with a warm undertone, glossy dark brown hair falling straight to the shoulders, refined bone structure with high cheekbones and a long elegant neck, polished natural makeup with luminous skin, defined brows and a soft neutral lip, poised upright posture, calm confident gaze, luxury campaign photography",
  },
  {
    key: "modelo_b",
    label: "Modelo B",
    description: "Modelo profissional de uns 32 anos, pele clara, cabelo castanho-claro em coque baixo impecável. Traços alongados, ar sereno.",
    prompt:
      "a professional high-fashion editorial model in her early thirties, fair skin, light brown hair pulled back into a sleek impeccable low chignon, elongated elegant features with a defined jawline, discreet luminous makeup and a neutral lip, small fine gold earrings, serene composed expression, graceful runway posture, luxury campaign photography",
  },
  {
    key: "modelo_c",
    label: "Modelo C",
    description: "Modelo profissional brasileira de uns 26 anos, pele parda clara, chanel curto e reto na altura do queixo. Presença moderna, de editorial.",
    prompt:
      "a professional Brazilian high-fashion editorial model in her mid-twenties, light brown skin, sleek blunt jaw-length bob with a sharp clean line, refined symmetrical features with high cheekbones, glowing skin with polished minimal makeup, long graceful neck left bare by the short hair, confident modern presence, luxury campaign photography",
  },
] as const;

export type HouseModelKey = (typeof HOUSE_MODELS)[number]["key"];
export const HOUSE_MODEL_KEYS = HOUSE_MODELS.map((model) => model.key) as [HouseModelKey, ...HouseModelKey[]];

/** Corpos P/M/G/GG: a foto-base de cada tamanho é o que "veja no seu tamanho" troca. */
export const BODY_SIZES = [
  { key: "P", label: "P", prompt: "slim build, Brazilian clothing size P (36–38)" },
  { key: "M", label: "M", prompt: "average build, Brazilian clothing size M (40–42)" },
  { key: "G", label: "G", prompt: "curvy build, Brazilian clothing size G (44–46)" },
  { key: "GG", label: "GG", prompt: "plus-size build, Brazilian clothing size GG (48–50)" },
] as const;

export type BodySizeKey = (typeof BODY_SIZES)[number]["key"];
export const BODY_SIZE_KEYS = BODY_SIZES.map((size) => size.key) as [BodySizeKey, ...BodySizeKey[]];

/** Econômica = try-on leve (1 crédito); alta = try-on em 2K (3 créditos). Decisão da dona no painel. */
export const STUDIO_QUALITIES = ["economica", "alta"] as const;
export type StudioQuality = (typeof STUDIO_QUALITIES)[number];

export function sceneByKey(key: string): (typeof SCENE_PRESETS)[number] | null {
  return SCENE_PRESETS.find((scene) => scene.key === key) ?? null;
}

export function houseModelByKey(key: string): (typeof HOUSE_MODELS)[number] | null {
  return HOUSE_MODELS.find((model) => model.key === key) ?? null;
}

export function bodySizeByKey(key: string): (typeof BODY_SIZES)[number] | null {
  return BODY_SIZES.find((size) => size.key === key) ?? null;
}
