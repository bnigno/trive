import {
  CorreiosQuoteUnavailableError,
  SUPERFRETE_SERVICE_CODES,
  type CorreiosQuoteFailureReason,
  type CorreiosQuoteInput,
  type CorreiosQuoteResult,
  type CorreiosQuoter,
} from "./index";

/** Sem roteiro: PAC R$ 22,90 (6–9 dias úteis) e SEDEX R$ 39,90 (2–3) para qualquer trecho. */
const DEFAULT_RESULTS: readonly CorreiosQuoteResult[] = [
  { service: "PAC", serviceCode: "1", priceCents: 2290, deliveryDaysMin: 6, deliveryDaysMax: 9, raw: { id: 1, name: "PAC", fake: true } },
  { service: "SEDEX", serviceCode: "2", priceCents: 3990, deliveryDaysMin: 2, deliveryDaysMax: 3, raw: { id: 2, name: "SEDEX", fake: true } },
];

/**
 * Cotação roteirizável: `set` troca a resposta, `failNext` simula o provedor
 * fora do ar na próxima chamada, `calls` guarda o que foi pedido.
 */
export class FakeCorreiosQuoter implements CorreiosQuoter {
  readonly calls: CorreiosQuoteInput[] = [];
  private scripted: CorreiosQuoteResult[] | null = null;
  private failures: CorreiosQuoteFailureReason[] = [];

  /** null volta ao roteiro padrão. */
  set(results: CorreiosQuoteResult[] | null): void {
    this.scripted = results ? results.map((result) => ({ ...result })) : null;
  }

  failNext(reason: CorreiosQuoteFailureReason = "network"): void {
    this.failures.push(reason);
  }

  async quote(input: CorreiosQuoteInput): Promise<CorreiosQuoteResult[]> {
    this.calls.push({ ...input, package: { ...input.package }, services: [...input.services] });
    const failure = this.failures.shift();
    if (failure) {
      throw new CorreiosQuoteUnavailableError(`SuperFrete indisponível (fake: ${failure}).`, failure);
    }
    const codes = new Set(input.services.map((service) => SUPERFRETE_SERVICE_CODES[service]));
    return (this.scripted ?? DEFAULT_RESULTS)
      .filter((result) => codes.has(result.serviceCode))
      .map((result) => ({ ...result }));
  }

  reset(): void {
    this.calls.length = 0;
    this.scripted = null;
    this.failures = [];
  }
}
