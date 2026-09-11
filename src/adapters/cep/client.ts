import { z } from "zod";

import { CepLookupUnavailableError, type CepAddress, type CepLookup } from "./index";

const TIMEOUT_MS = 5_000;

const brasilApiSchema = z.looseObject({
  cep: z.string(),
  state: z.string(),
  city: z.string(),
  neighborhood: z.string().nullable().optional(),
  street: z.string().nullable().optional(),
});

const viaCepSchema = z.looseObject({
  erro: z.union([z.boolean(), z.string()]).optional(),
  cep: z.string().optional(),
  logradouro: z.string().optional(),
  bairro: z.string().optional(),
  localidade: z.string().optional(),
  uf: z.string().optional(),
});

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/**
 * BrasilAPI v2 primeiro (agrega várias bases); 404 = CEP inexistente. Erro de
 * rede/5xx/resposta torta → ViaCEP (erro:true = inexistente). Os dois fora →
 * CepLookupUnavailableError, e quem chama segue sem endereço. Corpo de erro
 * nunca é relançado (não vaza nada nos logs).
 */
export class BrasilApiCepClient implements CepLookup {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async lookup(cepDigits: string): Promise<CepAddress | null> {
    const cep = cepDigits.replace(/\D/g, "");
    if (cep.length !== 8) return null;

    const primary = await this.fromBrasilApi(cep);
    if (primary.kind === "found") return primary.address;
    if (primary.kind === "missing") return null;

    const fallback = await this.fromViaCep(cep);
    if (fallback.kind === "found") return fallback.address;
    if (fallback.kind === "missing") return null;
    throw new CepLookupUnavailableError("Consulta de CEP indisponível (BrasilAPI e ViaCEP).");
  }

  private async fromBrasilApi(
    cep: string,
  ): Promise<{ kind: "found"; address: CepAddress } | { kind: "missing" } | { kind: "error" }> {
    try {
      const response = await this.fetchImpl(`https://brasilapi.com.br/api/cep/v2/${cep}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) return { kind: "missing" };
      if (!response.ok) return { kind: "error" };
      const parsed = brasilApiSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: "error" };
      return {
        kind: "found",
        address: {
          cep,
          street: parsed.data.street?.trim() ?? "",
          district: parsed.data.neighborhood?.trim() ?? "",
          city: parsed.data.city.trim(),
          state: parsed.data.state.trim().toUpperCase().slice(0, 2),
        },
      };
    } catch {
      return { kind: "error" };
    }
  }

  private async fromViaCep(
    cep: string,
  ): Promise<{ kind: "found"; address: CepAddress } | { kind: "missing" } | { kind: "error" }> {
    try {
      const response = await this.fetchImpl(`https://viacep.com.br/ws/${cep}/json/`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return { kind: "error" };
      const parsed = viaCepSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: "error" };
      if (parsed.data.erro === true || parsed.data.erro === "true") return { kind: "missing" };
      if (!parsed.data.localidade || !parsed.data.uf) return { kind: "error" };
      return {
        kind: "found",
        address: {
          cep,
          street: parsed.data.logradouro?.trim() ?? "",
          district: parsed.data.bairro?.trim() ?? "",
          city: parsed.data.localidade.trim(),
          state: parsed.data.uf.trim().toUpperCase().slice(0, 2),
        },
      };
    } catch {
      return { kind: "error" };
    }
  }
}
