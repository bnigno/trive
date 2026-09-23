// A casa do ensaio (core, puro): listas fechadas, prompt da foto-base com
// modelo + corpo + cena + regra de realismo, e a categoria do try-on por
// tipo de peça — todo tipo cadastrado tem resposta (categoria ou "sem ensaio").
import { describe, expect, it } from "vitest";

import { PIECE_TYPES } from "@/core/catalog/piece-types";
import {
  BODY_SIZE_KEYS,
  BODY_SIZES,
  bodySizeByKey,
  HOUSE_MODEL_KEYS,
  HOUSE_MODELS,
  houseModelByKey,
  SCENE_KEYS,
  SCENE_PRESETS,
  sceneByKey,
  STUDIO_QUALITIES,
} from "@/core/studio/presets";
import { buildModelPhotoPrompt, buildScenePrompt, garmentCategoryFor, NEGATIVE_PROMPT, PHOTOGRAPHY_PROMPT } from "@/core/studio/prompts";

describe("presets do ensaio", () => {
  it("cenas, modelos, corpos e qualidades são listas fechadas sem chave repetida", () => {
    expect(new Set(SCENE_KEYS).size).toBe(SCENE_PRESETS.length);
    expect(new Set(HOUSE_MODEL_KEYS).size).toBe(HOUSE_MODELS.length);
    expect(new Set(BODY_SIZE_KEYS).size).toBe(BODY_SIZES.length);
    expect(SCENE_PRESETS).toHaveLength(5);
    expect(HOUSE_MODELS).toHaveLength(3);
    expect(BODY_SIZE_KEYS).toEqual(["P", "M", "G", "GG"]);
    expect(STUDIO_QUALITIES).toEqual(["economica", "alta"]);
    for (const scene of SCENE_PRESETS) expect(scene.key).toMatch(/^[a-z0-9_]+$/);
    expect(sceneByKey("sala_clara")?.label).toBe("Sala clara");
    expect(sceneByKey("praia")).toBeNull();
    expect(houseModelByKey("modelo_b")?.label).toBe("Modelo B");
    expect(bodySizeByKey("GG")?.label).toBe("GG");
    expect(bodySizeByKey("XG")).toBeNull();
  });

  it("o prompt da foto-base junta modelo, corpo, cena, a regra de fotografia e o que não pode", () => {
    const prompt = buildModelPhotoPrompt({ modelKey: "modelo_a", sceneKey: "varanda_16h", sizeKey: "G" });
    expect(prompt).toContain(houseModelByKey("modelo_a")!.prompt);
    expect(prompt).toContain(bodySizeByKey("G")!.prompt);
    expect(prompt).toContain(sceneByKey("varanda_16h")!.prompt);
    expect(prompt).toContain(PHOTOGRAPHY_PROMPT);
    expect(prompt).toContain(`Avoid: ${NEGATIVE_PROMPT}`);
    // A modelo veste básicos neutros: é o que deixa o try-on trocar qualquer peça depois.
    expect(PHOTOGRAPHY_PROMPT).toContain("tank top");
    expect(() => buildModelPhotoPrompt({ modelKey: "modelo_z", sceneKey: "varanda_16h", sizeKey: "M" })).toThrow(/Preset desconhecido/);
    expect(buildScenePrompt("azulejo")).toContain(sceneByKey("azulejo")!.prompt);
    expect(() => buildScenePrompt("praia")).toThrow(/Cena desconhecida/);
  });

  it("categoria do try-on: peça inteira, parte de cima ou de baixo; acessório não tem ensaio", () => {
    expect(garmentCategoryFor("vestido")).toBe("one-pieces");
    expect(garmentCategoryFor("macacao")).toBe("one-pieces");
    expect(garmentCategoryFor("conjunto")).toBe("one-pieces");
    expect(garmentCategoryFor("blusa")).toBe("tops");
    expect(garmentCategoryFor("kimono")).toBe("tops");
    expect(garmentCategoryFor("saia")).toBe("bottoms");
    expect(garmentCategoryFor("bermuda")).toBe("bottoms");
    expect(garmentCategoryFor("brinco")).toBeNull();
    expect(garmentCategoryFor("bolsa")).toBeNull();
    expect(garmentCategoryFor("outro")).toBeNull();
    expect(garmentCategoryFor(null)).toBeNull();
    // Todo tipo da lista tem resposta definida (categoria ou null), nunca undefined.
    for (const type of PIECE_TYPES) {
      expect([null, "tops", "bottoms", "one-pieces"]).toContain(garmentCategoryFor(type.slug));
    }
  });
});
