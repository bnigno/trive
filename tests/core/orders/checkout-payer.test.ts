// O comprador que vai ao antifraude do Mercado Pago. Em 09–10/2026, 7 de 9
// tentativas de cartão pelo site foram recusadas com cc_rejected_high_risk
// porque a preferência mandava só o e-mail — e, sem e-mail, nada.
import { describe, expect, it } from "vitest";

import { buildCheckoutPayer, splitName, splitPhoneBR } from "@/core/orders/checkout-payer";

const SEM_NADA = {
  fullName: null,
  email: null,
  phoneE164: null,
  documentType: null,
  documentNumber: null,
};

describe("splitName", () => {
  it("separa nome e sobrenome como o MP espera", () => {
    expect(splitName("Maria da Silva")).toEqual({ firstName: "Maria", lastName: "da Silva" });
    expect(splitName("  Ana   Clara  Souza ")).toEqual({ firstName: "Ana", lastName: "Clara Souza" });
  });

  it("nome de uma palavra repete no sobrenome — em branco conta contra", () => {
    expect(splitName("Sabrina")).toEqual({ firstName: "Sabrina", lastName: "Sabrina" });
  });
});

describe("splitPhoneBR", () => {
  it("quebra o E.164 brasileiro em DDD e número", () => {
    expect(splitPhoneBR("+5591981641754")).toEqual({ areaCode: "91", number: "981641754" });
    // Fixo, 10 dígitos.
    expect(splitPhoneBR("+559132221100")).toEqual({ areaCode: "91", number: "32221100" });
  });

  it("o que não é telefone brasileiro vira null — DDD errado é pior que nada", () => {
    expect(splitPhoneBR("+351912345678")).toBeNull();
    expect(splitPhoneBR("+5591")).toBeNull();
    expect(splitPhoneBR("")).toBeNull();
  });
});

describe("buildCheckoutPayer", () => {
  it("manda tudo o que a loja tem", () => {
    const payer = buildCheckoutPayer(
      {
        fullName: "Maria da Silva",
        email: "maria@example.com",
        phoneE164: "+5511999998888",
        documentType: "cpf",
        documentNumber: "529.982.247-25",
      },
      { postalCode: "01310-100", street: "Avenida Paulista", number: "1000" },
    );

    expect(payer).toEqual({
      firstName: "Maria",
      lastName: "da Silva",
      email: "maria@example.com",
      document: { type: "CPF", number: "52998224725" },
      phone: { areaCode: "11", number: "999998888" },
      address: { zipCode: "01310100", streetName: "Avenida Paulista", streetNumber: "1000" },
    });
  });

  it("sem CPF e sem e-mail, ainda vai nome e telefone — era o que faltava", () => {
    // O caso do pedido #1034 ao contrário: a loja tinha os dados e mandava
    // nada. Com nome e telefone a compra deixa de ser anônima.
    const payer = buildCheckoutPayer({
      ...SEM_NADA,
      fullName: "Kayllane Silva",
      phoneE164: "+5591984136570",
    });

    expect(payer).toEqual({
      firstName: "Kayllane",
      lastName: "Silva",
      phone: { areaCode: "91", number: "984136570" },
    });
    // Nada em branco: o MP conta campo vazio contra, não ignora.
    expect(Object.keys(payer)).not.toContain("email");
    expect(Object.keys(payer)).not.toContain("document");
    expect(Object.keys(payer)).not.toContain("address");
  });

  it("CNPJ é reconhecido pelos 14 dígitos, mesmo com o tipo torto", () => {
    expect(
      buildCheckoutPayer({ ...SEM_NADA, fullName: "Loja X", documentNumber: "11.222.333/0001-81" })
        .document,
    ).toEqual({ type: "CNPJ", number: "11222333000181" });
  });

  it("documento com quantidade errada de dígitos é omitido, não enviado torto", () => {
    expect(buildCheckoutPayer({ ...SEM_NADA, fullName: "A B", documentNumber: "123" }).document).toBeUndefined();
  });

  it("endereço sem CEP válido ou sem rua é omitido; sem número vira s/n", () => {
    const semRua = buildCheckoutPayer({ ...SEM_NADA, fullName: "A B" }, { postalCode: "68795000" });
    expect(semRua.address).toBeUndefined();

    const semNumero = buildCheckoutPayer(
      { ...SEM_NADA, fullName: "A B" },
      { postalCode: "68795000", street: "Loteamento Benfica" },
    );
    expect(semNumero.address).toEqual({
      zipCode: "68795000",
      streetName: "Loteamento Benfica",
      streetNumber: "s/n",
    });
  });

  it("cliente sem nenhum dado não quebra — devolve o mínimo", () => {
    expect(buildCheckoutPayer(SEM_NADA)).toEqual({ firstName: "", lastName: "" });
  });
});
