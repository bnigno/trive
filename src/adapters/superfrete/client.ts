import { z } from "zod";

import type { CorreiosServiceName } from "@/core/shipping/correios-package";

import {
  CorreiosQuoteUnavailableError,
  SUPERFRETE_SERVICE_CODES,
  type CorreiosQuoteInput,
  type CorreiosQuoteResult,
  type CorreiosQuoter,
} from "./index";

/** Produção. O sandbox (https://sandbox.superfrete.com, token próprio) entra por SUPERFRETE_BASE_URL. */
const DEFAULT_BASE_URL = "https://api.superfrete.com";
/** Cabe no orçamento do turno da Lia e da server action da sacola; estourou → plano B (frete pela equipe). */
const TIMEOUT_MS = 6_000;
/** A SuperFrete exige "Aplicação (contato)". Mesmo contato do Nominatim (geocoding/client.ts). */
const USER_AGENT = "TRIVE/1.0 (contato@trivemaison.com.br)";

const itemSchema = z.looseObject({
  id: z.number(),
  name: z.string().optional(),
  price: z.union([z.number(), z.string()]).optional(),
  delivery_time: z.number().optional(),
  delivery_range: z.object({ min: z.number(), max: z.number() }).optional(),
  has_error: z.boolean().optional(),
  error: z.string().optional(),
});
const responseSchema = z.array(itemSchema);
type SuperFreteItem = z.infer<typeof itemSchema>;

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

/**
 * POST /api/v0/calculator: origem, destino, serviços "1,2" e UM pacote
 * (dimensões em cm, peso em kg — `package` prevalece sobre `products`).
 * A resposta é uma lista com um item por serviço; `price` já vem com o
 * desconto da SuperFrete e o prazo é em dias úteis a partir da postagem.
 * Corpo de erro nunca é relançado (não vaza nada nos logs).
 */
export class SuperFreteClient implements CorreiosQuoter {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async quote(input: CorreiosQuoteInput): Promise<CorreiosQuoteResult[]> {
    const token = process.env.SUPERFRETE_TOKEN?.trim();
    if (!token) {
      throw new CorreiosQuoteUnavailableError("SUPERFRETE_TOKEN não configurado.", "no_token");
    }
    const baseUrl = (process.env.SUPERFRETE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const body = {
      from: { postal_code: input.fromCep },
      to: { postal_code: input.toCep },
      services: input.services.map((service) => SUPERFRETE_SERVICE_CODES[service]).join(","),
      options: { own_hand: false, receipt: false, insurance_value: 0, use_insurance_value: false },
      package: {
        height: input.package.heightCm,
        width: input.package.widthCm,
        length: input.package.lengthCm,
        weight: input.weightGrams / 1000,
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/api/v0/calculator`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new CorreiosQuoteUnavailableError(
        timedOut ? "A SuperFrete não respondeu a tempo." : "Sem conexão com a SuperFrete.",
        timedOut ? "timeout" : "network",
      );
    }
    if (!response.ok) {
      throw new CorreiosQuoteUnavailableError(`A SuperFrete respondeu HTTP ${response.status}.`, `http_${response.status}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new CorreiosQuoteUnavailableError("A SuperFrete devolveu uma resposta inválida.", "invalid_response");
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CorreiosQuoteUnavailableError("A SuperFrete devolveu uma resposta fora do formato.", "invalid_response");
    }
    return parsed.data.flatMap((item) => {
      const result = toResult(item, input.services);
      return result ? [result] : [];
    });
  }
}

/**
 * Um item da resposta vira cotação só quando é um serviço pedido, sem erro,
 * com preço positivo e prazo. `price` chega como número ou string ("39.90");
 * o arredondamento para centavos é o único float que existe aqui.
 */
export function toResult(item: SuperFreteItem, services: readonly CorreiosServiceName[]): CorreiosQuoteResult | null {
  if (item.has_error === true || (typeof item.error === "string" && item.error.trim() !== "")) return null;
  const service = services.find((name) => Number(SUPERFRETE_SERVICE_CODES[name]) === item.id);
  if (!service) return null;
  const price = Number(item.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const priceCents = Math.round(price * 100);
  const min = item.delivery_range?.min ?? item.delivery_time;
  const max = item.delivery_range?.max ?? item.delivery_time;
  if (min === undefined || max === undefined || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0) {
    return null;
  }
  return {
    service,
    serviceCode: SUPERFRETE_SERVICE_CODES[service],
    priceCents,
    deliveryDaysMin: Math.min(min, max),
    deliveryDaysMax: Math.max(min, max),
    raw: item,
  };
}
