// Endereço pelo CEP: valida, consulta o adapter e traduz o resultado em algo
// que checkout, painel e Lia mostram sem quebrar quando o vendor falha.
import { CepLookupUnavailableError, type CepAddress, type CepLookup } from "@/adapters/cep";
import { cepDigits } from "@/lib/cep";

export type AddressLookupResult =
  | { ok: true; address: CepAddress }
  | { ok: false; reason: "cep_invalido" | "nao_encontrado" | "indisponivel" };

export async function lookupAddressByCep(
  lookup: CepLookup,
  cep: string,
): Promise<AddressLookupResult> {
  const digits = cepDigits(cep);
  if (!digits) return { ok: false, reason: "cep_invalido" };
  try {
    const address = await lookup.lookup(digits);
    if (!address) return { ok: false, reason: "nao_encontrado" };
    return { ok: true, address };
  } catch (error) {
    if (error instanceof CepLookupUnavailableError) return { ok: false, reason: "indisponivel" };
    throw error;
  }
}

/** "Avenida Paulista, Bela Vista — São Paulo/SP" (sem número: quem sabe é a cliente). */
export function formatLookedUpAddress(address: Pick<CepAddress, "street" | "district" | "city" | "state">): string {
  const local = [address.street, address.district].filter((part) => part.trim() !== "").join(", ");
  const cityUf = `${address.city}/${address.state}`;
  return local ? `${local} — ${cityUf}` : cityUf;
}
