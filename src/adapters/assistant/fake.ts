import type { BotToolName } from "@/core/bot/tools";

import type {
  AssistantTurn,
  ExtractFromPhotosInput,
  ExtractFromPhotosResult,
  RespondTurnInput,
  SalesAssistant,
} from "./index";

/** Rascunho canônico para demos em ADAPTER_MODE=fake (sem roteiro). */
export const FAKE_PRODUCT_DRAFT_JSON = {
  name: "Vestido Áurea",
  categorySlug: null,
  colors: ["Areia", "Terracota"],
  sizes: ["P", "M", "G"],
  description:
    "Vestido longo de linho com caimento fluido e alças finas, pensado para as tardes de calor: o tecido respira, seca rápido e acompanha o corpo sem marcar. O decote reto e a saia evasê alongam a silhueta; o comprimento midi-longo fica elegante com rasteira de dia e com salto à noite. Em Belém, é a peça que vai do almoço em família ao fim de tarde na orla sem perder o frescor — a umidade não pesa no linho, e a cor areia combina com a luz da cidade.",
  composition: "100% linho",
  careSymbols: ["hand_wash", "dry_shade"],
  careFreeText: "",
  fitNotes: "Corte fluido, comprimento midi-longo, alças finas ajustáveis.",
  weightGramsEstimate: 320,
  measurementsBySize: [
    { size: "P", bust: 88, waist: 70, hip: 94, length: 138 },
    { size: "M", bust: 92, waist: 74, hip: 98, length: 139 },
    { size: "G", bust: 96, waist: 78, hip: 102, length: 140 },
  ],
  warnings: [],
};

export type FakeTurnScript = {
  toolCalls?: { name: BotToolName; input: unknown }[];
  replyTemplate: string | ((toolTexts: string[]) => string);
};

/**
 * Assistente roteirizável para testes/demos: cada respondTurn consome o
 * próximo roteiro da fila (executando as ferramentas na ordem); sem roteiro,
 * ecoa a última mensagem do usuário.
 */
/**
 * Chegada do Ateliê sem roteiro: nada além do que o recado diz — o nome sai
 * do recado (name vazio), sem grade, sem custo. Os testes que querem a grade
 * enfileiram a proposta completa.
 */
export const FAKE_ARRIVAL_JSON = {
  name: "",
  categorySlug: null,
  description: "",
  composition: "",
  careSymbols: [],
  careFreeText: "",
  fitNotes: "",
  colors: [],
  sizes: [],
  sizeRange: null,
  quantityPerVariant: null,
  totalQuantity: null,
  costCents: null,
  costBasis: "unknown",
  supplierName: null,
  weightGramsEstimate: null,
  warnings: [],
};

export class FakeSalesAssistant implements SalesAssistant {
  /** Um Error na fila faz o próximo respondTurn lançar (modelo fora do ar). */
  private readonly scripts: Array<FakeTurnScript | Error> = [];
  readonly turns: AssistantTurn[] = [];
  /** O que cada turno recebeu (prompt, histórico com fotos) — para os testes. */
  readonly inputs: RespondTurnInput[] = [];
  private readonly extractionScripts: unknown[] = [];
  /** O que cada extração recebeu (prompt, fotos, schema) — para os testes. */
  readonly extractions: ExtractFromPhotosInput[] = [];

  enqueueScript(script: FakeTurnScript | Error): void {
    this.scripts.push(script);
  }

  /** Próxima extractFromPhotos devolve este JSON (ou lança, se for um Error). */
  enqueueExtraction(json: unknown): void {
    this.extractionScripts.push(json);
  }

  async extractFromPhotos(input: ExtractFromPhotosInput): Promise<ExtractFromPhotosResult> {
    this.extractions.push(input);
    const scripted = this.extractionScripts.shift();
    if (scripted instanceof Error) throw scripted;
    // Sem roteiro, responde no formato que o schema pediu: a chegada do
    // Ateliê (costBasis), a comparação de fotos (matches: nenhuma bate) ou a
    // ficha pela foto.
    const properties = (input.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const fallback = "costBasis" in properties ? FAKE_ARRIVAL_JSON : "matches" in properties ? { matches: [] } : FAKE_PRODUCT_DRAFT_JSON;
    return {
      json: scripted === undefined ? fallback : scripted,
      usage: { inputTokens: 4200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  async respondTurn(input: RespondTurnInput): Promise<AssistantTurn> {
    this.inputs.push(input);
    const script = this.scripts.shift();
    if (script instanceof Error) throw script;
    const turn = script
      ? await this.playScript(script, input)
      : this.echoTurn(input);
    this.turns.push(turn);
    return turn;
  }

  private async playScript(
    script: FakeTurnScript,
    input: RespondTurnInput,
  ): Promise<AssistantTurn> {
    const toolTexts: string[] = [];
    const toolCalls: { name: string; ok: boolean }[] = [];
    let handedOff = false;

    for (const call of script.toolCalls ?? []) {
      const result = await input.executeTool(call.name, call.input);
      toolCalls.push({ name: call.name, ok: result.ok });
      toolTexts.push(result.text);
      if (result.endsTurn) {
        handedOff = true;
        break;
      }
    }

    const reply =
      typeof script.replyTemplate === "function"
        ? script.replyTemplate(toolTexts)
        : script.replyTemplate;

    return {
      reply,
      toolCalls,
      handedOff,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private echoTurn(input: RespondTurnInput): AssistantTurn {
    const lastUserMessage = input.history
      .filter((message) => message.role === "user")
      .at(-1);
    const photos = lastUserMessage?.images?.length ?? 0;
    return {
      reply: `FAKE: ${lastUserMessage?.text ?? ""}${photos > 0 ? ` [+${photos} foto(s)]` : ""}`,
      toolCalls: [],
      handedOff: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  reset(): void {
    this.scripts.length = 0;
    this.turns.length = 0;
    this.inputs.length = 0;
    this.extractionScripts.length = 0;
    this.extractions.length = 0;
  }
}
