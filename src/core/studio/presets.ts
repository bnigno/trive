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
] as const;

export type SceneKey = (typeof SCENE_PRESETS)[number]["key"];
export const SCENE_KEYS = SCENE_PRESETS.map((scene) => scene.key) as [SceneKey, ...SceneKey[]];

export const HOUSE_MODELS = [
  {
    key: "modelo_a",
    label: "Modelo A",
    description: "Amazônida de uns 28 anos, pele morena quente, cabelo escuro ondulado solto, sorriso tranquilo.",
    prompt:
      "a Brazilian woman from the Amazon region in her late twenties, warm brown skin, long dark wavy hair worn loose, natural face with no heavy makeup, relaxed easy smile",
  },
  {
    key: "modelo_b",
    label: "Modelo B",
    description: "Mulher negra de uns 32 anos, pele retinta, cabelo crespo curto, expressão calma e segura.",
    prompt:
      "a Black Brazilian woman in her early thirties, deep brown skin, short natural coily hair, calm confident expression, small gold hoop earrings",
  },
  {
    key: "modelo_c",
    label: "Modelo C",
    description: "Mulher de uns 25 anos, descendência indígena e portuguesa, pele parda clara, cabelo liso em coque baixo, sardas leves.",
    prompt:
      "a Brazilian woman in her mid-twenties of Indigenous and Portuguese descent, light brown skin, straight black hair in a low bun, soft neutral expression, light freckles",
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
