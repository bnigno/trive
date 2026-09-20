// Regras puras do reconhecimento de peça na foto: ranking por hash com os
// limiares 8/10, a triagem da comparação visual (0,75/0,5) e os textos que a
// ferramenta devolve ao modelo.
import { describe, expect, it } from "vitest";

import {
  describePhotoMatches,
  PHOTO_MATCH_CONFIDENT,
  PHOTO_MATCH_JSON_SCHEMA,
  PHOTO_MATCH_MAX_DISTANCE,
  PHOTO_MATCH_MAYBE,
  PHOTO_MATCH_MAYBE_DISTANCE,
  photoMatchSystemPrompt,
  photoMatchUserText,
  rankPhotoMatches,
  tierVisionMatches,
  type IndexedPhoto,
  type PhotoMatchOutcome,
} from "@/core/bot/photo-match";
import { hexToPhash, phashToHex } from "@/core/images/phash";

/** Um hash a `bits` de distância do zero (os `bits` mais baixos ligados). */
const withBits = (bits: number) => phashToHex((BigInt(1) << BigInt(bits)) - BigInt(1));
const ZERO = hexToPhash("0000000000000000")!;

const PHOTOS: IndexedPhoto[] = [
  { phash: withBits(0), slug: "blusa-maelle", name: "Blusa Maelle", color: "Preto/marshmellow" },
  { phash: withBits(6), slug: "blusa-maelle", name: "Blusa Maelle", color: "Amarelo/vinho" },
  { phash: withBits(9), slug: "vestido-alba", name: "Vestido Alba", color: "Off-White" },
  { phash: withBits(11), slug: "vestido-evora", name: "Vestido Évora", color: null },
  { phash: "hash-torto", slug: "corset", name: "Corset", color: null },
];

describe("rankPhotoMatches", () => {
  it("limiares: ≤ 8 é exato, 9–10 é talvez, acima sai; agrupa por peça com a menor distância e as cores; hash torto é ignorado", () => {
    expect(PHOTO_MATCH_MAX_DISTANCE).toBe(8);
    expect(PHOTO_MATCH_MAYBE_DISTANCE).toBe(10);
    const ranked = rankPhotoMatches(ZERO, PHOTOS);
    expect(ranked).toEqual([
      { slug: "blusa-maelle", name: "Blusa Maelle", distance: 0, colors: ["Preto/marshmellow", "Amarelo/vinho"], tier: "exact" },
      { slug: "vestido-alba", name: "Vestido Alba", distance: 9, colors: ["Off-White"], tier: "maybe" },
    ]);
  });

  it("a mesma foto em duas peças públicas aparece duas vezes (a Lia pergunta); ordem por distância e nome", () => {
    const photos: IndexedPhoto[] = [
      { phash: withBits(3), slug: "vestido-serena", name: "Vestido Serena", color: null },
      { phash: withBits(3), slug: "vestido-dafne", name: "Vestido Dafne", color: null },
    ];
    expect(rankPhotoMatches(ZERO, photos).map((m) => m.slug)).toEqual(["vestido-dafne", "vestido-serena"]);
  });
});

describe("tierVisionMatches", () => {
  const candidates = [
    { slug: "blusa-maelle", name: "Blusa Maelle" },
    { slug: "blusa-aurelie", name: "Blusa Aurélie" },
  ];

  it("≥ 0,75 é provável, 0,5–0,75 é talvez, abaixo sai; slug fora das candidatas e repetido são ignorados; ordena por confiança", () => {
    expect(PHOTO_MATCH_CONFIDENT).toBe(0.75);
    expect(PHOTO_MATCH_MAYBE).toBe(0.5);
    const tiers = tierVisionMatches(
      {
        matches: [
          { slug: "blusa-aurelie", confidence: 0.6, color: null },
          { slug: "blusa-maelle", confidence: 0.92, color: "preto" },
          { slug: "blusa-maelle", confidence: 0.4, color: null },
          { slug: "inventada", confidence: 0.99, color: null },
          { slug: "blusa-aurelie", confidence: 0.3, color: null },
        ],
      },
      candidates,
    );
    expect(tiers).toEqual({
      provaveis: [{ slug: "blusa-maelle", name: "Blusa Maelle", confidence: 0.92, color: "preto" }],
      talvez: [{ slug: "blusa-aurelie", name: "Blusa Aurélie", confidence: 0.6, color: null }],
    });
  });

  it("resposta fora do formato vira null; lista vazia vira dois arrays vazios", () => {
    expect(tierVisionMatches({ matches: "x" }, candidates)).toBeNull();
    expect(tierVisionMatches(null, candidates)).toBeNull();
    expect(tierVisionMatches({ matches: [] }, candidates)).toEqual({ provaveis: [], talvez: [] });
  });

  it("o JSON Schema é uma lista sem $ref, com required, e a legenda numera as imagens a partir da 2", () => {
    expect(JSON.stringify(PHOTO_MATCH_JSON_SCHEMA)).not.toContain("$ref");
    expect(PHOTO_MATCH_JSON_SCHEMA).toMatchObject({ type: "object", required: ["matches"], additionalProperties: false });
    expect(photoMatchUserText(candidates)).toBe("Imagem 1: a foto da cliente.\nImagem 2: blusa-maelle — Blusa Maelle\nImagem 3: blusa-aurelie — Blusa Aurélie\nQuais desses rótulos aparecem na imagem 1?");
    expect(photoMatchSystemPrompt()).toContain("a MESMA peça");
    expect(photoMatchSystemPrompt()).not.toMatch(/\b(menu|card[áa]pio)\b/i);
  });
});

describe("describePhotoMatches", () => {
  const empty: PhotoMatchOutcome = { exact: [], maybe: [], provaveis: [], talvez: [], visionSkipped: null };
  const maelle = { slug: "blusa-maelle", name: "Blusa Maelle", distance: 6, colors: ["Preto/marshmellow"], tier: "exact" as const };

  it("uma exata: nome, slug, cores, ordem para detalhar_produto e o marcador; nunca preço ou estoque", () => {
    const result = describePhotoMatches({ ...empty, exact: [maelle] });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Reconheci na foto: Blusa Maelle (slug blusa-maelle; fotos nas cores Preto/marshmellow)");
    expect(result.text).toContain("detalhar_produto");
    expect(result.text).toContain("[reconhecimento exato]");
    expect(result.text).not.toMatch(/R\$|estoque disponível/);
  });

  it("várias exatas: pede para perguntar qual, citando os nomes", () => {
    const result = describePhotoMatches({ ...empty, exact: [maelle, { ...maelle, slug: "blusa-aurelie", name: "Blusa Aurélie", colors: [] }] });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("mais de uma peça");
    expect(result.text).toContain("Blusa Maelle (slug blusa-maelle; fotos nas cores Preto/marshmellow); Blusa Aurélie (slug blusa-aurelie)");
    expect(result.text).toContain("Pergunte qual ela quis dizer");
  });

  it("provável (visão) e talvez (hash 9–10 ou visão 0,5–0,75) pedem confirmação em 1 pergunta, com o marcador provável", () => {
    const likely = describePhotoMatches({ ...empty, provaveis: [{ slug: "blusa-maelle", name: "Blusa Maelle", confidence: 0.9, color: "preto" }] });
    expect(likely.ok).toBe(true);
    expect(likely.text).toContain("Provavelmente é Blusa Maelle (slug blusa-maelle; na cor preto)");
    expect(likely.text).toContain('Confirme em meia frase ("é a Blusa Maelle?")');
    expect(likely.text).toContain("[reconhecimento provável]");

    const maybe = describePhotoMatches({ ...empty, maybe: [{ ...maelle, distance: 9, tier: "maybe" }], talvez: [{ slug: "blusa-aurelie", name: "Blusa Aurélie", confidence: 0.6, color: null }] });
    expect(maybe.ok).toBe(true);
    expect(maybe.text).toContain("Talvez seja Blusa Maelle (slug blusa-maelle; fotos nas cores Preto/marshmellow); Blusa Aurélie (slug blusa-aurelie)");
    expect(maybe.text).toContain("Confirme com a cliente em 1 pergunta");
  });

  it("nada reconhecido: ok false com o caminho das parecidas e o motivo de a visão não ter rodado", () => {
    expect(describePhotoMatches(empty)).toEqual({ ok: false, text: "Não reconheci nenhuma peça do catálogo nessa foto: diga o que viu e busque parecidas com listar_produtos (categoria + cor)." });
    expect(describePhotoMatches({ ...empty, visionSkipped: "sem_tempo" }).text).toContain("[sem tempo para a comparação visual neste turno]");
    expect(describePhotoMatches({ ...empty, visionSkipped: "sem_bytes" }).text).toContain("[foto de um turno anterior");
    expect(describePhotoMatches({ ...empty, visionSkipped: "falhou" }).text).toContain("[a comparação visual falhou agora]");
    expect(describePhotoMatches({ ...empty, visionSkipped: "sem_deps" }).text).not.toContain("[");
  });
});
