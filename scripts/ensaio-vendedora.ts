// Ensaio de conversa com a vendedora usando a API REAL da Anthropic e o
// catálogo do banco apontado por DATABASE_URL, em modo ensaio (nada de pedido,
// Pix, aviso ou transferência de verdade). Imprime cada balão, as ferramentas
// chamadas e o custo aproximado, e falha se o vocabulário de restaurante
// escapar. Custa centavos por rodada.
//
// Uso:
//   ANTHROPIC_API_KEY=... DATABASE_URL=postgres://... npx tsx scripts/ensaio-vendedora.ts [roteiro]
//   … ensaio-vendedora.ts foto --foto ./print.jpg      (a Lia vê a foto no 1º turno)
//   … ensaio-vendedora.ts audio-real --audio ./x.ogg   (transcreve com OPENAI_API_KEY e usa como fala)
// Roteiros: casamento (padrão), direto, troca, audio, foto, audio-real
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ClaudeSalesAssistant } from "@/adapters/assistant/claude";
import { getFileStorage } from "@/adapters/storage";
import { renderCardPng } from "@/cards/render";
import { loadReceiptAssets } from "@/receipts/assets";
import type { BotChatMessage, BotImageInput } from "@/adapters/assistant";
import { OpenAiTranscriber } from "@/adapters/transcription/client";
import { splitBotReply } from "@/core/bot/reply";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import { getDb } from "@/db/client";
import {
  assembleHistory,
  buildBotPromptBundle,
  buildToolExecutor,
  type BotAttachment,
} from "@/services/wa-bot";
import { prepareImageForModel } from "@/services/wa-media";

const ROTEIROS: Record<string, string[]> = {
  casamento: [
    "oi",
    "tô procurando um vestido pra um casamento de dia, em outubro",
    "gosto de tons terrosos, uso M",
    "adorei o primeiro, tem no M?",
    "quero esse. meu cep é 66055-260",
    "vocês são robô?",
  ],
  direto: [
    "quero ver o catálogo",
    "quanto custa a peça mais barata?",
    "manda a foto",
  ],
  troca: [
    "comprei um vestido semana passada e veio com um fio puxado, quero trocar",
  ],
  audio: ["[a cliente enviou um áudio]", "ah tá, quero um look pra jantar"],
  foto: [`${INBOUND_MEDIA_MARKERS.image} tem alguma parecida com essa?`, "e no M, tem?"],
  "audio-real": ["<audio>", "uso M"],
};

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const PROIBIDAS = /\b(menu|menus|card[áa]pio|card[áa]pios)\b/iu;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("Defina ANTHROPIC_API_KEY no ambiente para o ensaio.");
  }
  const roteiroNome = process.argv[2] ?? "casamento";
  const roteiro = ROTEIROS[roteiroNome];
  if (!roteiro) throw new Error(`Roteiro desconhecido: ${roteiroNome}`);

  // --foto: a imagem vai anexada no 1º turno, como no WhatsApp.
  const fotoPath = flagValue("--foto");
  let foto: BotImageInput | undefined;
  if (fotoPath) {
    const prepared = await prepareImageForModel(await readFile(fotoPath));
    foto = { mediaType: prepared.mediaType, base64: prepared.base64 };
    console.log(`foto: ${fotoPath} → ${prepared.width}×${prepared.height} (${Math.round(prepared.base64.length * 0.75 / 1024)} KB)`);
  }
  // --audio: transcreve de verdade (OPENAI_API_KEY) e usa o texto como fala.
  const audioPath = flagValue("--audio");
  if (audioPath) {
    const started = Date.now();
    const transcription = await new OpenAiTranscriber().transcribe({
      data: await readFile(audioPath),
      mimeType: audioPath.endsWith(".mp3") ? "audio/mpeg" : audioPath.endsWith(".m4a") ? "audio/mp4" : "audio/ogg",
      languageHint: "pt",
    });
    console.log(`áudio: ${audioPath} → "${transcription.text}" (${Date.now() - started} ms, ${transcription.model})`);
    const index = roteiro.indexOf("<audio>");
    if (index >= 0) roteiro[index] = `[áudio da cliente, transcrição automática] ${transcription.text}`;
  }

  const db = getDb();
  const assistant = new ClaudeSalesAssistant();
  const bundle = await buildBotPromptBundle(db);
  console.log(`vendedora: ${bundle.sellerName} · modelo: ${bundle.model} · prompt: ${bundle.system.length} chars\n`);

  const conversationId = randomUUID();
  const messages: BotChatMessage[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let vocabularioFalhou = false;

  for (const fala of roteiro) {
    console.log(`\n👩 cliente: ${fala}`);
    const anexa = foto !== undefined && messages.length === 0;
    messages.push({
      role: "user",
      text: anexa ? `${fala} (a foto está anexada nesta mensagem)` : fala,
      ...(anexa && foto ? { images: [foto] } : {}),
    });
    const attachments: BotAttachment[] = [];
    const executeTool = buildToolExecutor(db, {
      conversationId,
      phoneE164: "+5511900000000",
      customerId: null,
      lastInboundId: randomUUID(),
      onAttachment: (attachment) => attachments.push(attachment),
      dryRun: true,
      cards: {
        storage: getFileStorage(),
        render: async (data) => renderCardPng(data, await loadReceiptAssets()),
      },
    });
    // Ensaio sem conversa gravada: o caderninho fica vazio de propósito.
    const history = assembleHistory({}, messages);
    const started = Date.now();
    const turn = await assistant.respondTurn({
      system: bundle.system,
      history,
      model: bundle.model,
      executeTool,
    });
    const ms = Date.now() - started;
    totalIn += turn.usage.inputTokens;
    totalOut += turn.usage.outputTokens;
    cacheRead += turn.usage.cacheReadTokens ?? 0;
    cacheWrite += turn.usage.cacheWriteTokens ?? 0;

    for (const attachment of attachments) {
      if (attachment.kind === "option_list") {
        console.log(
          `   📋 lista «${attachment.buttonLabel}» (${attachment.options.length}): ${attachment.options
            .map((option) => option.title)
            .join(" | ")}`,
        );
      } else {
        console.log(`   🖼️ ${attachment.caption} → ${attachment.imageUrl}`);
      }
    }
    const bubbles = turn.reply ? splitBotReply(turn.reply) : [];
    for (const bubble of bubbles) {
      console.log(`💛 ${bundle.sellerName}: ${bubble.replace(/\n/g, "\n      ")}`);
      if (PROIBIDAS.test(bubble)) vocabularioFalhou = true;
    }
    console.log(
      `   ⚙️ ${turn.toolCalls.map((call) => `${call.name}${call.ok ? "" : "✗"}`).join(", ") || "sem ferramenta"} · ${ms} ms · ${turn.usage.inputTokens}/${turn.usage.outputTokens} tokens${turn.handedOff ? " · TRANSFERIU" : ""}`,
    );
    if (turn.reply) messages.push({ role: "assistant", text: turn.reply });
    if (turn.handedOff) break;
  }

  // Sonnet 5: US$ 3/MTok entrada (input_tokens já exclui o cache), cache
  // lido a 10%, cache gravado por 1 h a 2×, US$ 15/MTok saída.
  const custoUsd =
    (totalIn * 3 + cacheRead * 0.3 + cacheWrite * 6 + totalOut * 15) / 1_000_000;
  console.log(
    `\ntokens: entrada ${totalIn} (cache lido ${cacheRead}, gravado ${cacheWrite}) · saída ${totalOut} · ≈ US$ ${custoUsd.toFixed(3)}`,
  );
  if (vocabularioFalhou) {
    throw new Error("A vendedora falou 'menu' ou 'cardápio' — o polimento pegaria, mas releia o prompt.");
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Ensaio falhou:", error);
  process.exit(1);
});
