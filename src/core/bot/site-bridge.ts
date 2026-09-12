// A ponte do site para a Lia — PURO. O toque em "Falar com a Lia" leva um
// código curto na mensagem ("#K7F2"); a primeira mensagem da cliente traz o
// código de volta, e a Lia abre a conversa já sabendo da peça. Aqui moram o
// alfabeto do código (sem 0/O, 1/I/L — ninguém confunde ao ler), a mensagem
// pronta por origem e o rótulo de onde a cliente veio.

import { z } from "zod";

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

const CODE_PATTERN = new RegExp(`#\\s?([${BRIDGE_CODE_ALPHABET}]{${BRIDGE_CODE_LENGTH}})(?![${BRIDGE_CODE_ALPHABET}])`, "i");

/**
 * O código dentro de uma mensagem ("Oi Lia, vi o Longo Dunas (#K7F2)"):
 * maiúsculo, o primeiro que aparecer; null quando não há.
 */
export function extractBridgeCode(text: string): string | null {
  const match = CODE_PATTERN.exec(text.toUpperCase());
  return match ? match[1] : null;
}

/** Retrato de uma peça na ponte (o que a cliente estava vendo). */
export const bridgeItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  /** "Areia · M"; vazio para peça sem variação. */
  variation: z.string().default(""),
  quantity: z.number().int().min(1).max(20),
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
};

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
    return `${oi} minha sacola no site: ${lista} ${tag}`;
  }
  if (input.product) {
    const onde = input.source === "campaign" ? " no story" : "";
    return `${oi} vi o ${itemPhrase(input.product)}${onde} ${tag}`;
  }
  return `${oi} vim pelo site ${tag}`;
}

/** "página da peça", "sacola", "rodapé do site", "story «verao»" — para o caderninho e o painel. */
export function originLabel(source: BridgeSource, campaignSlug?: string | null): string {
  switch (source) {
    case "pdp":
      return "página da peça";
    case "cart":
      return "sacola";
    case "footer":
      return "rodapé do site";
    case "campaign":
      return campaignSlug ? `story «${campaignSlug}»` : "story";
  }
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
  const at = new Date(bridge.at);
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  const quando = minutes < 3 ? "agora" : minutes < 60 ? `há ${minutes} min` : minutes < 60 * 24 ? `há ${Math.round(minutes / 60)} h` : `há ${Math.round(minutes / (60 * 24))} dia(s)`;
  const onde = bridge.sourceLabel ?? originLabel(bridge.source);
  if (bridge.items && bridge.items.length > 0) {
    const lista = bridge.items.map((item) => `${item.quantity}× ${item.name}${item.variation ? ` (${item.variation})` : ""}`).join(", ");
    return `Veio do site ${quando} (${onde}) com a sacola: ${lista}`;
  }
  if (bridge.productName) {
    return `Veio do site ${quando} (${onde}): ${bridge.productName}${bridge.variation ? ` (${bridge.variation})` : ""}`;
  }
  return `Veio do site ${quando} (${onde})`;
}
