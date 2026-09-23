// Prévia das MODELOS DA CASA, sem banco e sem fila: gera uma foto-base por
// modelo direto no vendor e salva em disco, para a dona olhar antes de pedir
// o elenco inteiro pela fila. É o passo barato antes de gastar de verdade —
// o elenco e a direção de fotografia são decisão de marca, e decisão de marca
// se toma vendo, não lendo prompt.
//
// Uso: npx tsx --env-file=.env.prod.local scripts/preview-modelos.ts [--cena estudio] [--tamanho M] [--modelos modelo_a,modelo_c] [pasta]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FashnImageStudio } from "@/adapters/image-studio/fashn";
import { creditsToUsdCents, usdCentsToBrlCents } from "@/core/studio/cost";
import { HOUSE_MODEL_KEYS, houseModelByKey, sceneByKey } from "@/core/studio/presets";
import { buildModelPhotoPrompt } from "@/core/studio/prompts";
import { formatCentsBRL } from "@/lib/money";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const sceneKey = arg("--cena") ?? "estudio";
  const sizeKey = arg("--tamanho") ?? "M";
  const modelos = (arg("--modelos")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [...HOUSE_MODEL_KEYS]);
  const outDir = process.argv.filter((a) => !a.startsWith("--")).at(-1)?.includes("/")
    ? process.argv.at(-1)!
    : ".preview/modelos";

  if (!sceneByKey(sceneKey)) throw new Error(`Cena desconhecida: ${sceneKey}`);
  mkdirSync(outDir, { recursive: true });

  const studio = new FashnImageStudio();
  let creditos = 0;
  const linhas: string[] = [];

  for (const modelKey of modelos) {
    const model = houseModelByKey(modelKey);
    if (!model) throw new Error(`Modelo desconhecido: ${modelKey}`);
    const prompt = buildModelPhotoPrompt({ modelKey, sceneKey, sizeKey });
    process.stdout.write(`${model.label} (${model.description})\n  gerando… `);
    const [image] = await studio.createModelPhoto({ prompt, aspectRatio: "3:4", count: 1, quality: "alta" });
    if (!image) throw new Error(`${modelKey}: o vendor não devolveu imagem.`);
    const file = join(outDir, `${modelKey}-${sceneKey}-${sizeKey}.jpg`);
    writeFileSync(file, image.data);
    creditos += image.creditsUsed;
    linhas.push(`${model.label}: ${file} (${image.creditsUsed} créditos, ${(image.elapsedMs / 1000).toFixed(0)}s)`);
    process.stdout.write(`ok → ${file}\n`);
  }

  const brl = usdCentsToBrlCents(creditsToUsdCents(creditos));
  const conta = `\nCena: ${sceneKey} · corpo: ${sizeKey}\n${linhas.join("\n")}\nTotal: ${creditos} créditos ≈ ${formatCentsBRL(brl)}\n`;
  writeFileSync(join(outDir, "custo.txt"), conta.trimStart());
  process.stdout.write(conta);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
