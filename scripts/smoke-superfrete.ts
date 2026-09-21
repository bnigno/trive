// Smoke da cotação dos Correios com a API REAL da SuperFrete: uma chamada ao
// POST /api/v0/calculator para um trecho e um peso. Instancia o cliente real
// direto (ignora ADAPTER_MODE), não usa banco nem cache. Cotar é grátis e não
// cria nada na conta — vale rodar antes de ligar o toggle em /admin/frete.
// Uso: npx tsx --env-file=.env.prod.local scripts/smoke-superfrete.ts --de 66045-335 --para 01310-100 [--peso 600]
import { CorreiosQuoteUnavailableError } from "@/adapters/superfrete";
import { SuperFreteClient } from "@/adapters/superfrete/client";
import { billableWeightGrams, CORREIOS_SERVICES, DEFAULT_PACKAGE_CM } from "@/core/shipping/correios-package";
import { cepDigits } from "@/lib/cep";
import { formatCentsBRL } from "@/lib/money";

const USAGE = "Uso: npx tsx --env-file=.env.prod.local scripts/smoke-superfrete.ts --de <CEP> --para <CEP> [--peso <gramas>]";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function cepArg(name: string): string {
  const raw = arg(name);
  const digits = raw ? cepDigits(raw) : null;
  if (!digits) throw new Error(`${name} precisa de um CEP com 8 dígitos. ${USAGE}`);
  return digits;
}

function weightArg(): number {
  const raw = arg("--peso");
  if (raw === undefined) return billableWeightGrams(0);
  const grams = Number(raw);
  if (!Number.isInteger(grams) || grams <= 0) throw new Error(`--peso precisa de gramas inteiros. ${USAGE}`);
  return billableWeightGrams(grams);
}

function days(min: number, max: number): string {
  return min === max ? `${min} ${min === 1 ? "dia útil" : "dias úteis"}` : `${min} a ${max} dias úteis`;
}

/** O item bruto sem a foto da transportadora (URL longa que só faz barulho). */
function compactRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const { company, ...rest } = raw as Record<string, unknown>;
  const companyName = company && typeof company === "object" ? (company as Record<string, unknown>).name : company;
  return companyName === undefined ? rest : { ...rest, company: companyName };
}

async function main() {
  if (!process.env.SUPERFRETE_TOKEN?.trim()) {
    throw new Error("Defina SUPERFRETE_TOKEN (em .env.prod.local ou no ambiente) para o smoke real.");
  }
  const fromCep = cepArg("--de");
  const toCep = cepArg("--para");
  const weightGrams = weightArg();
  const baseUrl = process.env.SUPERFRETE_BASE_URL?.trim() || "https://api.superfrete.com";

  console.log(`SuperFrete ${baseUrl} — ${fromCep} → ${toCep}, ${weightGrams} g, caixa ${DEFAULT_PACKAGE_CM.widthCm}×${DEFAULT_PACKAGE_CM.heightCm}×${DEFAULT_PACKAGE_CM.lengthCm} cm, serviços ${CORREIOS_SERVICES.join("+")}`);

  const started = Date.now();
  const results = await new SuperFreteClient().quote({
    fromCep,
    toCep,
    weightGrams,
    package: DEFAULT_PACKAGE_CM,
    services: CORREIOS_SERVICES,
  });
  console.log(`respondeu em ${Date.now() - started} ms`);

  if (results.length === 0) {
    throw new Error("A SuperFrete respondeu, mas sem PAC nem SEDEX para o trecho (confira os CEPs).");
  }
  for (const result of results) {
    console.log(`${result.service}: ${formatCentsBRL(result.priceCents)} — ${days(result.deliveryDaysMin, result.deliveryDaysMax)}`);
    console.log(`  raw: ${JSON.stringify(compactRaw(result.raw))}`);
  }
  process.exit(0);
}

main().catch((error) => {
  if (error instanceof CorreiosQuoteUnavailableError) {
    console.error(`Cotação indisponível (${error.reason}): ${error.message}`);
  } else {
    console.error("Smoke falhou:", error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
