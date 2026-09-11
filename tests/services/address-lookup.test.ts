import { describe, expect, it } from "vitest";

import { FakeCepLookup } from "@/adapters/cep/fake";
import { formatLookedUpAddress, lookupAddressByCep } from "@/services/address-lookup";

describe("lookupAddressByCep", () => {
  it("encontrado, inexistente, inválido e vendor fora do ar viram resultados, nunca exceções", async () => {
    const fake = new FakeCepLookup();
    expect(await lookupAddressByCep(fake, "01310-100")).toMatchObject({ ok: true, address: { city: "São Paulo" } });
    expect(await lookupAddressByCep(fake, "12345678")).toEqual({ ok: false, reason: "nao_encontrado" });
    expect(await lookupAddressByCep(fake, "123")).toEqual({ ok: false, reason: "cep_invalido" });
    fake.failNext();
    expect(await lookupAddressByCep(fake, "01310100")).toEqual({ ok: false, reason: "indisponivel" });
  });

  it("formata sem número, tolerando rua ou bairro vazios", () => {
    expect(formatLookedUpAddress({ street: "Avenida Paulista", district: "Bela Vista", city: "São Paulo", state: "SP" })).toBe(
      "Avenida Paulista, Bela Vista — São Paulo/SP",
    );
    expect(formatLookedUpAddress({ street: "", district: "", city: "Belém", state: "PA" })).toBe("Belém/PA");
  });
});
