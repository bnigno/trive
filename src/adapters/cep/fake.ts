import { CepLookupUnavailableError, type CepAddress, type CepLookup } from "./index";

/**
 * Consulta de CEP roteirizável: `set` cadastra endereços, `failNext` simula os
 * vendors fora do ar. Sem roteiro, conhece 01310100 (Av. Paulista) e
 * 66045335 (Belém) e devolve null para o resto.
 */
export class FakeCepLookup implements CepLookup {
  readonly calls: string[] = [];
  private readonly known = new Map<string, CepAddress>([
    [
      "01310100",
      { cep: "01310100", street: "Avenida Paulista", district: "Bela Vista", city: "São Paulo", state: "SP" },
    ],
    [
      "66045335",
      { cep: "66045335", street: "Travessa Três de Maio", district: "Cremação", city: "Belém", state: "PA" },
    ],
  ]);
  private failures = 0;

  set(cep: string, address: Omit<CepAddress, "cep">): void {
    const digits = cep.replace(/\D/g, "");
    this.known.set(digits, { cep: digits, ...address });
  }

  failNext(): void {
    this.failures += 1;
  }

  async lookup(cepDigits: string): Promise<CepAddress | null> {
    const digits = cepDigits.replace(/\D/g, "");
    this.calls.push(digits);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new CepLookupUnavailableError("vendor fora do ar (fake)");
    }
    const found = this.known.get(digits);
    return found ? { ...found } : null;
  }

  reset(): void {
    this.calls.length = 0;
    this.failures = 0;
  }
}
