// Prévia de "a peça se mexe": UMA foto no corpo (já aprovada) vira um vídeo
// curto (FASHN image-to-video). Sem --real roda contra o fake (sem rede, sem
// custo). Com --real instancia a FASHN direto (ignora ADAPTER_MODE), consulta
// o saldo ANTES, recusa se o vídeo passar do teto em créditos ou do saldo, e
// confere o saldo DEPOIS (a cobrança real contra a tabela). O pedido vai para
// pedido.json na pasta assim que a FASHN aceita: se algo falhar depois, rode
// com --retomar na MESMA pasta (só espera e baixa, não cobra de novo). Uma
// pasta com pedido não aceita pedido novo: um vídeo pago nunca é sobrescrito.
// Tudo vai para a pasta de saída: foto.jpg, video.mp4, prompt.txt, custo.txt
// e LEIA-ME.txt.
//
// Uso (fake):  npx tsx scripts/preview-video.ts [--imagem foto.jpg] [--tipo vestido] [pasta-de-saida]
// Uso (real):  npx tsx --env-file=.env.local scripts/preview-video.ts --real --imagem foto-no-corpo.jpg [--costas costas.jpg] [--tipo vestido] [--duracao 5|10] [--resolucao 480p|720p|1080p] [--teto-creditos 6] [--movimento "..."] [pasta-de-saida]
// Retomar:     npx tsx --env-file=.env.local scripts/preview-video.ts --real --retomar pasta-de-saida
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FashnImageStudio } from "@/adapters/image-studio/fashn";
import { StudioUnavailableError, type ImageStudio, type StudioVideo } from "@/adapters/image-studio/index";
import { formatUsdCents } from "@/core/ai/model-cost";
import { parsePieceType } from "@/core/catalog/piece-types";
import {
  creditsToUsdCents,
  usdCentsToBrlCents,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  videoCreditsFor,
  type VideoDurationSeconds,
  type VideoResolution,
} from "@/core/studio/cost";
import { buildVideoMotionPrompt, VIDEO_AI_NOTICE, VIDEO_DEFAULTS, videoFitsBudget } from "@/core/studio/video";
import { formatCentsBRL } from "@/lib/money";

/** O vídeo leva minutos (o 1º teste: 266 s); o adapter espera até 10 min, isto é a folga do download. */
const CALL_TIMEOUT_MS = 12 * 60_000;
/** Teto padrão: exatamente um vídeo de 5 s em 1080p. */
const DEFAULT_BUDGET_CREDITS = 6;
/** Lado maior da foto enviada: basta para 1080p e mantém o pedido leve. */
const MAX_IMAGE_SIDE = 2048;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function positional(): string | undefined {
  const withValue = new Set(["--imagem", "--costas", "--tipo", "--duracao", "--resolucao", "--teto-creditos", "--movimento"]);
  const args = process.argv.slice(2);
  return args.find((value, index) => !value.startsWith("--") && !(index > 0 && withValue.has(args[index - 1] ?? "")));
}

/** Foto de exemplo para o modo fake: um "vestido" liso, sem pessoa de verdade. */
async function samplePhoto(): Promise<Buffer> {
  const svg = `<svg width="900" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="1200" fill="#efe6da"/><path d="M360 160 L540 160 L600 380 L680 1120 L220 1120 L300 380 Z" fill="#6b2f4a"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

/** Gira pela EXIF, limita o lado maior e manda como JPEG (o que a FASHN espera). */
async function preparePhoto(data: Buffer): Promise<Buffer> {
  return sharp(data).rotate().resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
}

function parseDuration(raw: string | undefined): VideoDurationSeconds {
  if (raw === undefined) return VIDEO_DEFAULTS.durationSeconds;
  const found = VIDEO_DURATIONS.find((duration) => String(duration) === raw);
  if (!found) throw new Error(`--duracao precisa ser ${VIDEO_DURATIONS.join(" ou ")} (veio ${raw}).`);
  return found;
}

function parseResolution(raw: string | undefined): VideoResolution {
  if (raw === undefined) return VIDEO_DEFAULTS.resolution;
  const found = VIDEO_RESOLUTIONS.find((resolution) => resolution === raw);
  if (!found) throw new Error(`--resolucao precisa ser ${VIDEO_RESOLUTIONS.join(", ")} (veio ${raw}).`);
  return found;
}

function parseBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUDGET_CREDITS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--teto-creditos precisa ser um inteiro ≥ 1 (veio ${raw}).`);
  return value;
}

function money(credits: number): string {
  const usdCents = creditsToUsdCents(credits);
  return `${credits} crédito(s) = ${formatUsdCents(usdCents)} ≈ ${formatCentsBRL(usdCentsToBrlCents(usdCents))}`;
}

/** O pedido aceito pela FASHN, gravado na pasta: é o que --retomar lê (nunca digitado). */
const ORDER_FILE = "pedido.json";
const savedOrderSchema = z.object({
  jobId: z.string().trim().min(1),
  durationSeconds: z.union([z.literal(5), z.literal(10)]),
  resolution: z.enum(VIDEO_RESOLUTIONS),
  prompt: z.string(),
  balanceBefore: z.number().nullable(),
  submittedAt: z.string(),
});
type SavedOrder = z.infer<typeof savedOrderSchema>;

function resumeCommand(out: string): string {
  return `npx tsx --env-file=.env.local scripts/preview-video.ts --real --retomar ${JSON.stringify(out)}`;
}

/**
 * O que dizer quando falha. Depende de a FASHN já ter aceitado o pedido e de
 * o fim ser CERTO: só "failed" no corpo do status (sem HTTP de erro) ou 404
 * (ela não conhece o pedido) encerram; qualquer outra resposta deixa o
 * pedido aberto para retomar, porque ele pode ainda terminar e ser cobrado.
 */
function failureNote(error: StudioUnavailableError, jobId: string | null, resumed: boolean, out: string): { text: string; closeOrder: boolean } {
  if (jobId === null) {
    // Sem id: ou a FASHN respondeu recusando (qualquer HTTP abaixo de 500, ou a chave faltando aqui), ou a resposta não chegou.
    const refusedAtTheDoor = error.reason === "no_key" || (error.status !== undefined && error.status < 500);
    return {
      closeOrder: false,
      text: refusedAtTheDoor
        ? "A FASHN recusou o pedido na entrada: nada foi cobrado."
        : "A resposta da FASHN não chegou, então não dá para saber se ela recebeu o pedido. Confira o saldo daqui a uns 10 minutos antes de pedir de novo (se caiu, o vídeo foi feito — fale com o suporte deles pelo painel da FASHN).",
    };
  }
  if (error.reason === "rejected" && error.status === undefined) {
    return {
      closeOrder: true,
      text: `A FASHN terminou o pedido ${jobId} sem vídeo (recusou a foto ou o movimento): ela só cobra saída pronta, então nada foi cobrado. Pode pedir de novo nesta pasta.`,
    };
  }
  if (error.status === 404) {
    return {
      closeOrder: true,
      text: resumed
        ? `A FASHN não reconhece mais o pedido ${jobId} (a saída dela vale 3 dias, ou a chave mudou). O vídeo não dá mais para buscar; o saldo antes/agora acima mostra se houve cobrança.`
        : `A FASHN não reconhece o pedido ${jobId} que ela mesma acabou de aceitar: sem vídeo. Confira o saldo daqui a uns 10 minutos antes de pedir de novo.`,
    };
  }
  if (error.reason === "invalid_response") {
    return {
      closeOrder: false,
      text: `O pedido ${jobId} terminou, mas a saída veio fora do formato — pode ter sido cobrado. Dá para tentar baixar de novo sem pagar (vale por 3 dias): ${resumeCommand(out)}. Se falhar igual, a saída deles veio com defeito.`,
    };
  }
  return {
    closeOrder: false,
    text: `O pedido ${jobId} foi aceito e pode ainda terminar (a FASHN cobra quando termina, então o saldo pode cair depois). Para buscar o vídeo sem pagar de novo (vale por 3 dias): ${resumeCommand(out)}`,
  };
}

async function main() {
  const real = flag("--real");
  const resume = flag("--retomar");
  const out = positional() ?? join(".preview", "video");
  if (arg("--prompt") !== undefined) throw new Error("--prompt saiu: use --movimento \"...\" (troca só o gesto; a proibição de mudar a peça fica).");
  if (resume && !real) throw new Error("--retomar só faz sentido com --real.");
  if (real && !process.env.FASHN_API_KEY?.trim()) throw new Error("Defina FASHN_API_KEY (no .env.local ou no ambiente) para o vídeo real.");
  mkdirSync(out, { recursive: true });
  const orderPath = join(out, ORDER_FILE);
  const videoFile = real ? "video.mp4" : "video-fake.mp4";

  const fashn = real ? new FashnImageStudio() : null;
  const studio: ImageStudio = fashn ?? new FakeImageStudio();

  let order: Omit<SavedOrder, "jobId" | "submittedAt">;
  let photo: Buffer;
  let back: Buffer | undefined;
  let resumeJobId: string | undefined;
  if (resume) {
    // Retomar: tudo vem do pedido gravado — nada de flags que podem não bater com o que foi pago.
    if (!existsSync(orderPath)) throw new Error(`Nada para retomar: ${orderPath} não existe.`);
    if (existsSync(join(out, videoFile))) throw new Error(`O vídeo deste pedido já está em ${join(out, videoFile)}.`);
    const saved = savedOrderSchema.parse(JSON.parse(readFileSync(orderPath, "utf8")));
    resumeJobId = saved.jobId;
    order = saved;
    // A retomada não envia foto (só acompanha o pedido); a de antes fica como estava.
    photo = existsSync(join(out, "foto.jpg")) ? readFileSync(join(out, "foto.jpg")) : Buffer.alloc(0);
    console.log(`REAL (FASHN) — retomando o pedido ${saved.jobId} (${saved.durationSeconds} s em ${saved.resolution}): só espera e baixa, sem cobrar de novo → ${out}`);
  } else {
    if (real && existsSync(orderPath) && !existsSync(join(out, videoFile))) {
      throw new Error(`Esta pasta tem um pedido pago e ainda sem vídeo (${orderPath}). Para buscá-lo sem pagar de novo: ${resumeCommand(out)}. Para um vídeo novo, escolha outra pasta.`);
    }
    if (real && existsSync(join(out, videoFile))) {
      throw new Error(`Esta pasta já tem um vídeo (${join(out, videoFile)}). Para um vídeo novo, escolha outra pasta.`);
    }
    const imagePath = arg("--imagem");
    const backPath = arg("--costas");
    if (real && !imagePath) throw new Error("--real exige --imagem <foto no corpo aprovada>.");
    const durationSeconds = parseDuration(arg("--duracao"));
    const resolution = parseResolution(arg("--resolucao"));
    const budgetCredits = parseBudget(arg("--teto-creditos"));
    const pieceType = parsePieceType(arg("--tipo") ?? "vestido");

    photo = await preparePhoto(imagePath ? readFileSync(imagePath) : await samplePhoto());
    back = backPath ? await preparePhoto(readFileSync(backPath)) : undefined;
    writeFileSync(join(out, "foto.jpg"), photo);
    if (back) writeFileSync(join(out, "costas.jpg"), back);
    const prompt = buildVideoMotionPrompt({ pieceType, withBackView: back !== undefined, movement: arg("--movimento") });
    writeFileSync(join(out, "prompt.txt"), `${prompt}\n`);

    const balanceBefore = fashn ? await fashn.creditsBalance(AbortSignal.timeout(20_000)) : null;
    const fits = videoFitsBudget({ durationSeconds, resolution, budgetCredits, balanceCredits: balanceBefore });
    console.log(
      `${real ? "REAL (FASHN)" : "FAKE"} — ${durationSeconds} s em ${resolution}, tipo ${pieceType ?? "?"}${back ? ", com as costas" : ""} → ${out}\n` +
        `custo: ${money(fits.credits)} · teto ${budgetCredits} crédito(s)${balanceBefore === null ? "" : ` · saldo ${balanceBefore}`}`,
    );
    if (!fits.ok) {
      const note =
        fits.reason === "teto"
          ? `Não gerou: o vídeo custa ${fits.credits} crédito(s) e o teto é ${budgetCredits} (--teto-creditos).`
          : `Não gerou: o vídeo custa ${fits.credits} crédito(s) e o saldo da FASHN é ${balanceBefore}.`;
      writeFileSync(join(out, "parou_no_teto.txt"), `${note}\n`);
      throw new Error(note);
    }
    order = { durationSeconds, resolution, prompt, balanceBefore };
  }

  const started = Date.now();
  let jobId: string | null = resumeJobId ?? null;
  let video: StudioVideo;
  try {
    video = await studio.animate({
      image: { data: photo, mimeType: "image/jpeg" },
      endImage: back ? { data: back, mimeType: "image/jpeg" } : undefined,
      prompt: order.prompt,
      durationSeconds: order.durationSeconds,
      resolution: order.resolution,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      resumeJobId,
      onSubmitted: (id) => {
        jobId = id;
        if (!real) return;
        const saved: SavedOrder = { jobId: id, ...order, submittedAt: new Date().toISOString() };
        writeFileSync(orderPath, `${JSON.stringify(saved, null, 2)}\n`);
        console.log(`pedido aceito: ${id} (em ${orderPath}). Se cair daqui para a frente, busque sem pagar de novo: ${resumeCommand(out)}`);
      },
    });
  } catch (error) {
    if (error instanceof StudioUnavailableError && fashn) {
      const after = await fashn.creditsBalance(AbortSignal.timeout(20_000)).catch(() => null);
      const { text, closeOrder } = failureNote(error, jobId, resumeJobId !== undefined, out);
      if (closeOrder && existsSync(orderPath)) renameSync(orderPath, join(out, `pedido-encerrado-${Date.now()}.json`));
      const note = [`Falhou (${error.reason}): ${error.message}`, `Saldo antes ${order.balanceBefore ?? "?"}, agora ${after ?? "?"}.`, text].join("\n");
      writeFileSync(join(out, "falhou.txt"), `${note}\n`);
      throw new Error(note);
    }
    throw error;
  }
  writeFileSync(join(out, videoFile), video.data);
  // Uma falha anterior nesta pasta (antes do --retomar) já não vale: o vídeo chegou.
  if (existsSync(join(out, "falhou.txt"))) renameSync(join(out, "falhou.txt"), join(out, "falhou-antes-do-video.txt"));
  const balanceAfter = fashn ? await fashn.creditsBalance(AbortSignal.timeout(20_000)).catch(() => null) : null;
  const charged = order.balanceBefore !== null && balanceAfter !== null ? order.balanceBefore - balanceAfter : null;

  const custo = [
    `Vídeo ${real ? "REAL" : "FAKE"} — ${new Date().toISOString()}${resumeJobId ? ` (retomada do pedido ${resumeJobId})` : ""}`,
    `${order.durationSeconds} s em ${order.resolution} (${video.vendorModel}), ${Math.round((Date.now() - started) / 1000)} s de espera${resumeJobId ? " nesta retomada" : ""}, ${(video.data.byteLength / 1024 / 1024).toFixed(1)} MB`,
    `Custo do vídeo pela tabela: ${money(video.creditsUsed)}${resumeJobId ? " (cobrado uma vez, no pedido original)" : ""}`,
    order.balanceBefore === null
      ? "Saldo: não consultado (fake)."
      : `Saldo da FASHN: ${order.balanceBefore} antes do pedido → ${balanceAfter ?? "?"} agora${charged === null ? "" : ` (caiu ${charged}${charged === video.creditsUsed ? ", igual à tabela" : ` — a tabela dizia ${video.creditsUsed}: conferir src/core/studio/cost.ts (ou outro gasto no meio)`})`}.`,
    "",
    "A conta de um vídeo por peça (câmbio de referência R$ 5,50):",
    ...VIDEO_DURATIONS.flatMap((duration) => VIDEO_RESOLUTIONS.map((res) => `  ${duration} s ${res}: ${money(videoCreditsFor(duration, res))}`)),
  ].join("\n");
  writeFileSync(join(out, "custo.txt"), `${custo}\n`);
  writeFileSync(
    join(out, "LEIA-ME.txt"),
    [
      "O que olhar, nesta ordem:",
      `1. ${videoFile} ao lado de foto.jpg — a peça continua A MESMA do começo ao fim? Cor, estampa, botões, cinto, comprimento. Se ela muda no meio do movimento, o vídeo não entra (o que a cliente vê tem de ser a peça que chega).`,
      "2. Mãos, rosto e tecido — o movimento parece gente de verdade ou 'boneco'? O tecido cai como tecido?",
      "3. O vídeo sai no formato da foto (3:4). O Reels mostra 3:4 com faixa; 9:16 cheio pediria uma foto-base vertical — decisão para depois, se o vídeo convencer.",
      `4. Se entrar: sempre com o aviso "${VIDEO_AI_NOTICE}" na legenda e o rótulo de IA do Instagram; só no Instagram, nunca como prova de caimento na página da peça.`,
      "5. prompt.txt — o movimento pedido. Para tentar outro gesto, rode de novo NUMA PASTA NOVA com --movimento \"...\" (troca só o gesto; cada rodada custa de novo).",
    ].join("\n") + "\n",
  );
  console.log(`\n${custo}\n\nArquivos em ${out}`);
}

main().catch((error) => {
  console.error("Vídeo falhou:", error instanceof Error ? error.message : error);
  process.exit(1);
});
