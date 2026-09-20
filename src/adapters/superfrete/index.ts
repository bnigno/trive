// Cotação dos Correios (PAC/SEDEX) pela SuperFrete — token manual gerado no
// painel deles (sem OAuth, não expira). Vendor atrás de interface própria:
// real = client.ts (POST /api/v0/calculator), fake = roteirizável (fake.ts).
// Seleção por ADAPTER_MODE, como os demais adapters.
import type { CorreiosServiceName, PackageDimensionsCm } from "@/core/shipping/correios-package";

import { getAdapterMode } from "../adapter-mode";
import { SuperFreteClient } from "./client";
import { FakeCorreiosQuoter } from "./fake";

/** Códigos da SuperFrete: 1 = PAC, 2 = SEDEX (17 = Mini Envios, que não usamos). */
export const SUPERFRETE_SERVICE_CODES: Record<CorreiosServiceName, "1" | "2"> = { PAC: "1", SEDEX: "2" };

export interface CorreiosQuoteInput {
  /** 8 dígitos. */
  fromCep: string;
  /** 8 dígitos. */
  toCep: string;
  /** Peso a cobrar, em gramas (o chamador já aplicou o mínimo). */
  weightGrams: number;
  package: PackageDimensionsCm;
  services: readonly CorreiosServiceName[];
}

export interface CorreiosQuoteResult {
  service: CorreiosServiceName;
  serviceCode: "1" | "2";
  /** Preço do provedor (já com o desconto da SuperFrete), inteiro em centavos. */
  priceCents: number;
  /** Dias úteis a partir da postagem. */
  deliveryDaysMin: number;
  deliveryDaysMax: number;
  /** O item bruto da resposta (auditoria; não tem dado pessoal). */
  raw: unknown;
}

export interface CorreiosQuoter {
  /**
   * Só os serviços disponíveis para o trecho (itens com erro são
   * descartados); [] = nenhum. Lança CorreiosQuoteUnavailableError quando o
   * provedor não responde — quem chama decide o plano B.
   */
  quote(input: CorreiosQuoteInput): Promise<CorreiosQuoteResult[]>;
}

export type CorreiosQuoteFailureReason = "no_token" | "timeout" | "network" | "invalid_response" | `http_${number}`;

export class CorreiosQuoteUnavailableError extends Error {
  readonly reason: CorreiosQuoteFailureReason;

  constructor(message: string, reason: CorreiosQuoteFailureReason) {
    super(message);
    this.name = "CorreiosQuoteUnavailableError";
    this.reason = reason;
  }
}

/** Há como cotar neste ambiente? (fake: sempre; real: com SUPERFRETE_TOKEN). */
export function isCorreiosQuotesConfigured(): boolean {
  if (getAdapterMode() !== "real") return true;
  return typeof process.env.SUPERFRETE_TOKEN === "string" && process.env.SUPERFRETE_TOKEN.trim() !== "";
}

let instance: CorreiosQuoter | undefined;

export function getCorreiosQuoter(): CorreiosQuoter {
  if (!instance) {
    instance = getAdapterMode() === "real" ? new SuperFreteClient() : new FakeCorreiosQuoter();
  }
  return instance;
}
