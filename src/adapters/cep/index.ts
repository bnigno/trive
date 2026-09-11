// Consulta de CEP (o endereço se preenche sozinho no checkout, no painel e na
// conversa da Lia). Vendor atrás de interface própria: real = BrasilAPI com
// fallback ViaCEP (client.ts), fake = roteirizável (fake.ts). Seleção por
// ADAPTER_MODE, como os demais adapters. Sem chave: é grátis e público.
import { getAdapterMode } from "../adapter-mode";
import { BrasilApiCepClient } from "./client";
import { FakeCepLookup } from "./fake";

export type CepAddress = {
  /** 8 dígitos. */
  cep: string;
  street: string;
  district: string;
  city: string;
  /** UF com 2 letras. */
  state: string;
};

export interface CepLookup {
  /** null = CEP não existe; lança CepLookupUnavailableError se os vendors falharem. */
  lookup(cepDigits: string): Promise<CepAddress | null>;
}

export class CepLookupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CepLookupUnavailableError";
  }
}

let instance: CepLookup | undefined;

export function getCepLookup(): CepLookup {
  if (!instance) {
    instance = getAdapterMode() === "real" ? new BrasilApiCepClient() : new FakeCepLookup();
  }
  return instance;
}
