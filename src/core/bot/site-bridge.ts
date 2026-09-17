// A ponte do site para a Lia — PURO. O toque em "Falar com a Lia" leva um
// código curto na mensagem ("#K7F2"); a primeira mensagem da cliente traz o
// código de volta, e a Lia abre a conversa já sabendo da peça. Aqui moram o
// alfabeto do código (sem 0/O, 1/I/L — ninguém confunde ao ler), a mensagem
// pronta por origem e o rótulo de onde a cliente veio.

import { z } from "zod";

import { slugify } from "@/lib/slug";

/** 30 símbolos legíveis em qualquer fonte: sem 0/O, 1/I/L. */
export const BRIDGE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const BRIDGE_CODE_LENGTH = 4;

export const BRIDGE_SOURCES = ["pdp", "cart", "footer", "campaign"] as const;
export type BridgeSource = (typeof BRIDGE_SOURCES)[number];

/** Um código novo; `random` é injetável para o teste ser determinístico. */
export function generateBridgeCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < BRIDGE_CODE_LENGTH; index += 1) {
    const at = Math.min(BRIDGE_CODE_ALPHABET.length - 1, Math.floor(random() * BRIDGE_CODE_ALPHABET.length));
    code += BRIDGE_CODE_ALPHABET.charAt(at);
  }
  return code;
}

// A forma que o site manda é "(#K7F2)"; ela ganha de qualquer "#XXXX" solto.
const PAREN_CODE_PATTERN = new RegExp(`\\(#\\s?([${BRIDGE_CODE_ALPHABET}]{${BRIDGE_CODE_LENGTH}})\\)`, "gi");
// "#XXXX" solto: só quando termina ali (uma hashtag maior, "#natal", não é código).
const LOOSE_CODE_PATTERN = new RegExp(`#\\s?([${BRIDGE_CODE_ALPHABET}]{${BRIDGE_CODE_LENGTH}})(?![\\p{L}\\p{N}])`, "giu");

/**
 * O código dentro de uma mensagem ("Oi Lia, vi o Longo Dunas (#K7F2)"):
 * maiúsculo; a forma "(#XXXX)" do site vence, e entre várias vale a última
 * (o site põe o código no fim). Hashtag comum ("#natal") não é código. null
 * quando não há.
 */
export function extractBridgeCode(text: string): string | null {
  const upper = text.toUpperCase();
  const paren = [...upper.matchAll(PAREN_CODE_PATTERN)];
  if (paren.length > 0) return paren[paren.length - 1]![1]!;
  const loose = [...upper.matchAll(LOOSE_CODE_PATTERN)];
  return loose.length > 0 ? loose[loose.length - 1]![1]! : null;
}

/** Tetos da sacola na ponte — folgados: a sacola do site só limita pelo estoque. */
export const BRIDGE_MAX_LINES = 100;
export const BRIDGE_MAX_QTY = 999;

/** Retrato de uma peça na ponte (o que a cliente estava vendo). Mesmo teto de quem grava. */
export const bridgeItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  /** "Areia · M"; vazio para peça sem variação. */
  variation: z.string().default(""),
  quantity: z.number().int().min(1).max(BRIDGE_MAX_QTY),
  priceCents: z.number().int().min(0),
});
export type BridgeItem = z.infer<typeof bridgeItemSchema>;

export type BridgeMessageInput = {
  sellerName: string;
  code: string;
  source: BridgeSource;
  /** A peça em vista (pdp/campaign). */
  product?: { name: string; variation?: string } | null;
  /** A sacola (cart). */
  items?: readonly BridgeItem[];
  /** O CEP que a cliente digitou no checkout (8 dígitos): a Lia já cota certo — e, fora da área do motoboy, a equipe calcula os Correios. */
  cep?: string;
};

/** "68740000" → "68740-000"; outra coisa volta como veio. */
function cepLabel(cep: string): string {
  return /^\d{8}$/.test(cep) ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
}

function itemPhrase(item: { name: string; variation?: string }): string {
  const variation = item.variation?.trim();
  return variation ? `${item.name} em ${variation.toLowerCase()}` : item.name;
}

/**
 * A mensagem que abre o WhatsApp, já com o código no fim. Curta: a cliente
 * vê e manda como está ("Oi Lia, vi o Longo Dunas em areia · m (#K7F2)").
 */
export function buildBridgeMessage(input: BridgeMessageInput): string {
  const oi = `Oi ${input.sellerName.trim() || "Lia"},`;
  const tag = `(#${input.code})`;
  if (input.source === "cart" && input.items && input.items.length > 0) {
    const lista = input.items.map((item) => `${item.quantity}× ${itemPhrase(item)}`).join(", ");
    const entrega = input.cep ? `, entrega no CEP ${cepLabel(input.cep)}` : "";
    return `${oi} minha sacola no site: ${lista}${entrega} ${tag}`;
  }
  if (input.product) {
    const onde = input.source === "campaign" ? " no story" : "";
    return `${oi} vi o ${itemPhrase(input.product)}${onde} ${tag}`;
  }
  return `${oi} vim pelo ${input.source === "campaign" ? "story" : "site"} ${tag}`;
}

/**
 * "página da peça", "sacola", "rodapé do site", "story «Dunas»" — para o
 * caderninho e o painel. No story, o nome é o rótulo do link (ou o slug,
 * quando o link foi apagado).
 */
export function originLabel(source: BridgeSource, campaign?: string | null): string {
  switch (source) {
    case "pdp":
      return "página da peça";
    case "cart":
      return "sacola";
    case "footer":
      return "rodapé do site";
    case "campaign":
      return campaign?.trim() ? `story «${campaign.trim()}»` : "story";
  }
}

// ---------------------------------------------------------------------------
// Links de story (/ig/[slug])
// ---------------------------------------------------------------------------

export const CAMPAIGN_SLUG_MIN = 2;
export const CAMPAIGN_SLUG_MAX = 40;
export const CAMPAIGN_SLUG_RE = /^[a-z0-9-]{2,40}$/;

/**
 * "Círio 2026" → "cirio-2026"; "dunas" → "dunas". null quando não dá slug
 * (vazio, só símbolos, curto ou longo demais) — a dona escolhe outro.
 */
export function normalizeCampaignSlug(raw: string): string | null {
  const slug = slugify(raw);
  return CAMPAIGN_SLUG_RE.test(slug) ? slug : null;
}

/** O que o caderninho guarda da ponte (core/bot/memory.ts). */
export const bridgeStateSchema = z.object({
  siteCartId: z.string(),
  code: z.string(),
  source: z.enum(BRIDGE_SOURCES),
  sourceLabel: z.string().optional(),
  /** Quando a cliente tocou (ISO). */
  at: z.string(),
  productSlug: z.string().optional(),
  productName: z.string().optional(),
  variation: z.string().optional(),
  items: z.array(bridgeItemSchema).optional(),
});
export type BridgeState = z.infer<typeof bridgeStateSchema>;

/** A linha do caderninho: "Veio do site agora (página da peça): Longo Dunas (Areia · M)". */
export function bridgeContextLine(bridge: BridgeState, now: Date): string {
  const at = new Date(bridge.at).getTime();
  const minutes = Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 60_000)) : null;
  const quando =
    minutes === null
      ? ""
      : minutes < 3
        ? " agora"
        : minutes < 60
          ? ` há ${minutes} min`
          : minutes < 60 * 24
            ? ` há ${Math.round(minutes / 60)} h`
            : ` há ${Math.round(minutes / (60 * 24))} dia(s)`;
  const onde = bridge.sourceLabel ?? originLabel(bridge.source);
  // Fora da sacola, `items` é só a foto da peça para o estoque: a frase é da peça.
  if (bridge.source === "cart" && bridge.items && bridge.items.length > 0) {
    const lista = bridge.items.map((item) => `${item.quantity}× ${item.name}${item.variation ? ` (${item.variation})` : ""}`).join(", ");
    return `Veio do site${quando} (${onde}) com a sacola: ${lista}`;
  }
  if (bridge.productName) {
    return `Veio do site${quando} (${onde}): ${bridge.productName}${bridge.variation ? ` (${bridge.variation})` : ""}`;
  }
  return `Veio do site${quando} (${onde})`;
}

/** Ponte recente (até 1 h): o estoque das peças dela ainda vale a pena conferir. */
export const BRIDGE_FRESH_MS = 60 * 60 * 1000;

export function isBridgeFresh(bridge: BridgeState, now: Date): boolean {
  const at = new Date(bridge.at).getTime();
  return Number.isFinite(at) && now.getTime() - at <= BRIDGE_FRESH_MS;
}

/** Ponte vigente (até 24 h): depois disso o caderninho para de dizer "Veio do site". */
export const BRIDGE_CURRENT_MS = 24 * 60 * 60 * 1000;

export function isBridgeCurrent(bridge: BridgeState, now: Date): boolean {
  const at = new Date(bridge.at).getTime();
  return Number.isFinite(at) && now.getTime() - at <= BRIDGE_CURRENT_MS;
}
