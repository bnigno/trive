// Prévia do ensaio "foto no corpo": foto real da peça → foto-base da modela
// da casa → try-on → portão de fidelidade → acabamento. Sem --real roda tudo
// contra os fakes (sem banco, sem rede, sem custo). Com --real instancia os
// clientes reais direto (FASHN e Anthropic; ignora ADAPTER_MODE), gera para
// UMA peça, respeita um teto de gasto em R$ e para antes de estourar. Tudo
// vai para a pasta de saída: fotos-base, opções brutas, julgamentos,
// opções acabadas, custo.txt (a conta) e LEIA-ME.txt (o que olhar).
//
// Uso (fake):  npx tsx scripts/preview-ensaio.ts [--peca foto.jpg] [--cena sala_clara] [--modela modelo_a] [--tamanho M] [--tipo vestido] [--opcoes 3] [pasta-de-saida]
// Uso (real):  npx tsx --env-file=.env.prod.local scripts/preview-ensaio.ts --real --peca foto.jpg [--modela-foto base.jpg] [--qualidade economica|alta|ambas] [--teto-centavos 1000] [--sem-portao] [pasta-de-saida]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import type { SalesAssistant } from "@/adapters/assistant/index";
import { ClaudeSalesAssistant } from "@/adapters/assistant/claude";
import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FashnImageStudio } from "@/adapters/image-studio/fashn";
import { StudioUnavailableError, type ImageStudio, type StudioImage } from "@/adapters/image-studio/index";
import { estimateUsageCostUsdCents, formatUsdCents } from "@/core/ai/model-cost";
import { parsePieceType } from "@/core/catalog/piece-types";
import { creditsFor, creditsToUsdCents, JUDGE_USD_CENTS_PER_IMAGE, studioCostTable, usdCentsToBrlCents } from "@/core/studio/cost";
import { FIDELITY_JSON_SCHEMA, FIDELITY_SYSTEM_PROMPT, FIDELITY_USER_TEXT, fidelityJudgmentSchema, fidelitySummary, passesFidelity } from "@/core/studio/fidelity";
import { bodySizeByKey, houseModelByKey, sceneByKey, type StudioQuality } from "@/core/studio/presets";
import { buildModelPhotoPrompt, buildScenePrompt, garmentCategoryFor } from "@/core/studio/prompts";
import { formatCentsBRL } from "@/lib/money";
import { finishStudioImage } from "@/services/studio-finish";
import { prepareImageForModel } from "@/services/wa-media";

const JUDGE_MODEL = "claude-sonnet-5";
const CALL_TIMEOUT_MS = 90_000;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function positional(): string | undefined {
  const withValue = new Set(["--peca", "--cena", "--modela", "--tamanho", "--tipo", "--opcoes", "--modela-foto", "--qualidade", "--teto-centavos"]);
  const args = process.argv.slice(2);
  return args.find((value, index) => !value.startsWith("--") && !(index > 0 && withValue.has(args[index - 1] ?? "")));
}

/** Peça de exemplo para o modo fake: um "vestido" listrado, sem foto de verdade. */
async function sampleGarment(): Promise<Buffer> {
  const stripes = Array.from({ length: 12 }, (_, i) => `<rect x="0" y="${i * 100}" width="800" height="50" fill="#b23a48"/>`).join("");
  const svg = `<svg width="800" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="1200" fill="#f1e9dc"/><g clip-path="url(#p)"><rect width="800" height="1200" fill="#e8c9a0"/>${stripes}</g><defs><clipPath id="p"><path d="M300 120 L500 120 L560 320 L620 1100 L180 1100 L240 320 Z"/></clipPath></defs></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

type Ledger = { lines: string[]; usdCents: number; brlCents: number; tetoBrlCents: number };

function charge(ledger: Ledger, label: string, usdCents: number): void {
  ledger.usdCents += usdCents;
  ledger.brlCents = usdCentsToBrlCents(ledger.usdCents);
  ledger.lines.push(`${label}: ${formatUsdCents(usdCents)} (acumulado ${formatCentsBRL(ledger.brlCents)})`);
}

/** Antes de cada chamada paga: cabe no teto? Senão, para e conta o motivo. */
function ensureBudget(ledger: Ledger, nextUsdCents: number, what: string, out: string): void {
  const projected = usdCentsToBrlCents(ledger.usdCents + nextUsdCents);
  if (projected <= ledger.tetoBrlCents) return;
  const note = `Parou antes de ${what}: ${formatCentsBRL(projected)} passaria do teto de ${formatCentsBRL(ledger.tetoBrlCents)}. Gasto até aqui: ${formatCentsBRL(ledger.brlCents)}.`;
  writeFileSync(join(out, "parou_no_teto.txt"), `${note}\n`);
  writeFileSync(join(out, "custo.txt"), `${ledger.lines.join("\n")}\n${note}\n`);
  throw new Error(note);
}

async function judge(assistant: SalesAssistant, garment: Buffer, candidate: Buffer) {
  const [original, generated] = await Promise.all([prepareImageForModel(garment), prepareImageForModel(candidate)]);
  const started = Date.now();
  const result = await assistant.extractFromPhotos({
    system: FIDELITY_SYSTEM_PROMPT,
    images: [
      { mediaType: original.mediaType, base64: original.base64 },
      { mediaType: generated.mediaType, base64: generated.base64 },
    ],
    userText: FIDELITY_USER_TEXT,
    model: JUDGE_MODEL,
    jsonSchema: FIDELITY_JSON_SCHEMA,
    maxTokens: 512,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const parsed = fidelityJudgmentSchema.safeParse(result.json);
  return {
    judgment: parsed.success ? parsed.data : null,
    raw: result.json,
    usdCents: estimateUsageCostUsdCents(result.usage, JUDGE_MODEL),
    ms: Date.now() - started,
  };
}

async function main() {
  const real = flag("--real");
  const out = positional() ?? join(".preview", "ensaio");
  mkdirSync(out, { recursive: true });

  const sceneKey = arg("--cena") ?? "sala_clara";
  const modelKey = arg("--modela") ?? "modelo_a";
  const sizeKey = arg("--tamanho") ?? "M";
  const options = Math.min(4, Math.max(1, Number(arg("--opcoes") ?? 3) || 3));
  const pieceType = parsePieceType(arg("--tipo") ?? "vestido");
  const category = garmentCategoryFor(pieceType) ?? "auto";
  const qualityArg = arg("--qualidade") ?? (real ? "ambas" : "economica");
  const qualities = (qualityArg === "ambas" ? ["economica", "alta"] : [qualityArg]) as StudioQuality[];
  const withGate = !flag("--sem-portao");
  const tetoBrlCents = Number(arg("--teto-centavos") ?? 1000) || 1000;
  if (!sceneByKey(sceneKey) || !houseModelByKey(modelKey) || !bodySizeByKey(sizeKey)) {
    throw new Error(`Preset desconhecido (cena ${sceneKey}, modela ${modelKey}, tamanho ${sizeKey}).`);
  }
  for (const quality of qualities) {
    if (quality !== "economica" && quality !== "alta") throw new Error(`--qualidade precisa ser economica, alta ou ambas (veio ${quality}).`);
  }

  const pecaPath = arg("--peca");
  if (real && !pecaPath) throw new Error("--real exige --peca <foto da peça>.");
  if (real && !process.env.FASHN_API_KEY?.trim()) throw new Error("Defina FASHN_API_KEY (em .env.prod.local ou no ambiente) para o ensaio real.");
  if (real && withGate && !process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("Defina ANTHROPIC_API_KEY para o portão de fidelidade (ou use --sem-portao).");
  const garment = pecaPath ? readFileSync(pecaPath) : await sampleGarment();
  writeFileSync(join(out, "peca.jpg"), await sharp(garment).rotate().jpeg({ quality: 88 }).toBuffer());

  const studio: ImageStudio = real ? new FashnImageStudio() : new FakeImageStudio();
  const assistant: SalesAssistant = real ? new ClaudeSalesAssistant() : new FakeSalesAssistant();
  const ledger: Ledger = { lines: [], usdCents: 0, brlCents: 0, tetoBrlCents };
  console.log(`${real ? "REAL (FASHN + Anthropic)" : "FAKE"} — cena ${sceneKey}, modela ${modelKey}, tamanho ${sizeKey}, tipo ${pieceType ?? "?"} (${category}), ${options} opções, qualidade ${qualities.join("+")}, teto ${formatCentsBRL(tetoBrlCents)} → ${out}`);

  // 1. Foto-base da modela: a que veio por --modela-foto, ou gerada agora.
  let modelPhoto: Buffer;
  const modelPhotoPath = arg("--modela-foto");
  if (modelPhotoPath) {
    modelPhoto = readFileSync(modelPhotoPath);
    console.log(`foto-base: ${modelPhotoPath}`);
  } else {
    const baseQuality: StudioQuality = real ? "alta" : "economica";
    const baseCount = real ? 2 : 1;
    const baseCredits = creditsFor("model_photo", baseQuality, baseCount);
    ensureBudget(ledger, creditsToUsdCents(baseCredits), "gerar a foto-base", out);
    const started = Date.now();
    const photos = await studio.createModelPhoto({
      prompt: buildModelPhotoPrompt({ modelKey, sceneKey, sizeKey }),
      aspectRatio: "3:4",
      count: baseCount,
      quality: baseQuality,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    photos.forEach((photo, index) => writeFileSync(join(out, `modela-${index + 1}.jpg`), photo.data));
    charge(ledger, `foto-base ×${photos.length} (${photos[0]?.vendorModel}, ${baseCredits} créditos, ${Date.now() - started} ms)`, photos.reduce((sum, photo) => sum + photo.usdCents, 0));
    modelPhoto = photos[0]!.data;
    console.log(`foto-base: ${photos.length} candidata(s) em ${Date.now() - started} ms — usando modela-1.jpg (rode de novo com --modela-foto para trocar)`);
  }

  // 2. Try-on por qualidade, 3. portão, 4. acabamento.
  const summary: string[] = [];
  for (const quality of qualities) {
    const count = quality === "alta" && real && qualities.length > 1 ? 1 : options;
    const credits = creditsFor("tryon", quality, count);
    ensureBudget(ledger, creditsToUsdCents(credits) + (withGate ? JUDGE_USD_CENTS_PER_IMAGE * count : 0), `gerar ${count} opção(ões) ${quality}`, out);
    const started = Date.now();
    let images: StudioImage[];
    try {
      images = await studio.generateOnModel({
        garment: { data: garment, mimeType: "image/jpeg" },
        model: { data: modelPhoto, mimeType: "image/jpeg" },
        category,
        scenePrompt: buildScenePrompt(sceneKey),
        count,
        quality,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof StudioUnavailableError) {
        charge(ledger, `try-on ${quality} FALHOU (${error.reason})`, 0);
        console.error(`try-on ${quality}: ${error.message} (${error.reason})`);
        continue;
      }
      throw error;
    }
    charge(ledger, `try-on ${quality} ×${images.length} (${images[0]?.vendorModel}, ${credits} créditos, ${Date.now() - started} ms)`, images.reduce((sum, image) => sum + image.usdCents, 0));

    for (const [index, image] of images.entries()) {
      const tag = `${quality}-${index + 1}`;
      writeFileSync(join(out, `opcao-${tag}-bruta.jpg`), image.data);
      let verdict = "sem portão";
      let approved = true;
      if (withGate) {
        const judged = await judge(assistant, garment, image.data);
        charge(ledger, `julgamento ${tag} (${JUDGE_MODEL}, ${judged.ms} ms)`, judged.usdCents);
        writeFileSync(join(out, `julgamento-${tag}.json`), `${JSON.stringify(judged.raw, null, 2)}\n`);
        if (judged.judgment) {
          approved = passesFidelity(judged.judgment);
          verdict = fidelitySummary(judged.judgment);
        } else {
          approved = false;
          verdict = "julgamento fora do formato";
        }
      }
      const finished = await finishStudioImage(image.data);
      const file = approved ? `opcao-${tag}.jpg` : `opcao-${tag}-reprovada.jpg`;
      writeFileSync(join(out, file), finished);
      summary.push(`${file}: ${verdict} — ${formatUsdCents(image.usdCents)} + julgamento, semente ${image.seed ?? "?"}`);
      console.log(summary[summary.length - 1]);
    }
  }

  // 5. A conta.
  const table = (quality: StudioQuality) =>
    studioCostTable({ quality })
      .map((line) => `  ${line.label}: ${formatUsdCents(line.usdCents)} ≈ ${formatCentsBRL(line.brlCents)}`)
      .join("\n");
  const custo = [
    `Ensaio ${real ? "REAL" : "FAKE"} — ${new Date().toISOString()}`,
    `Gasto desta rodada: ${formatUsdCents(ledger.usdCents)} ≈ ${formatCentsBRL(ledger.brlCents)} (teto ${formatCentsBRL(tetoBrlCents)})`,
    "",
    ...ledger.lines,
    "",
    "A conta (câmbio de referência R$ 5,50; já com a retentativa média do portão e o julgamento):",
    "Qualidade econômica (tryon-v1.6):",
    table("economica"),
    "Qualidade alta (tryon-max 2K):",
    table("alta"),
    "",
    "Opções desta rodada:",
    ...summary.map((line) => `  ${line}`),
  ].join("\n");
  writeFileSync(join(out, "custo.txt"), `${custo}\n`);
  writeFileSync(
    join(out, "LEIA-ME.txt"),
    [
      "O que olhar, nesta ordem:",
      "1. modela-*.jpg — a foto-base: parece foto de celular numa tarde em Belém? Pele real, luz natural, fundo com vida? Se não, é o prompt em src/core/studio/prompts.ts que muda, antes de qualquer peça.",
      "2. opcao-*-bruta.jpg ao lado de peca.jpg — a estampa, a cor e o corte são OS MESMOS? Mãos e rosto estão certos?",
      "3. julgamento-*.json — o portão concordou com o seu olho? Nota ≥ 7 e nenhum defeito listado = aprovada.",
      "4. opcao-*.jpg (acabada) — ao lado de uma foto real do feed, ela salta ou some no meio? É essa que iria para o Instagram.",
      "5. custo.txt — a conta por foto, por peça e por mês, nas duas qualidades.",
      "Reprovadas ficam com o sufixo -reprovada: se você discorda do portão, o corte (FIDELITY_MIN_SCORE) está em src/core/studio/fidelity.ts.",
    ].join("\n") + "\n",
  );
  console.log(`\n${custo}\n\nArquivos em ${out}`);
}

main().catch((error) => {
  console.error("Ensaio falhou:", error instanceof Error ? error.message : error);
  process.exit(1);
});
