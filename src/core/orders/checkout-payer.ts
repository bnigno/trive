// Quem está comprando, do jeito que o antifraude do Mercado Pago precisa ver.
//
// Em 09–10/2026, 7 de 9 tentativas de cartão pelo site foram recusadas com
// `cc_rejected_high_risk`, enquanto os links feitos à mão no app do MP — que
// levavam e-mail e CPF — aprovaram 3 de 3. A diferença não era o cartão: era
// que a preferência da loja mandava só o e-mail, e só quando existia. No
// pedido #1034 a loja TINHA nome, CPF e telefone da cliente e enviou nada.
//
// Puro de propósito: é a regra de "o que o MP vê", e se testa sozinha.

/** O comprador como o MP espera; campo ausente é OMITIDO, nunca vazio. */
export type CheckoutPayerData = {
  firstName: string;
  lastName: string;
  email?: string;
  document?: { type: "CPF" | "CNPJ"; number: string };
  phone?: { areaCode: string; number: string };
  address?: { zipCode: string; streetName: string; streetNumber: string };
};

export type PayerCustomer = {
  fullName: string | null;
  email: string | null;
  phoneE164: string | null;
  documentType: string | null;
  documentNumber: string | null;
};

/** O endereço do pedido (jsonb), na forma que a loja grava. */
export type PayerAddress = {
  postalCode?: unknown;
  street?: unknown;
  number?: unknown;
};

function limpo(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  return texto === "" ? null : texto;
}

/**
 * O MP trata nome e sobrenome separados: a primeira palavra é o nome, o resto
 * é o sobrenome. Nome de uma palavra só repete — `last_name` vazio seria um
 * campo em branco, que o antifraude conta contra.
 */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const partes = fullName.trim().split(/\s+/).filter((parte) => parte !== "");
  if (partes.length === 0) return { firstName: "", lastName: "" };
  if (partes.length === 1) return { firstName: partes[0], lastName: partes[0] };
  return { firstName: partes[0], lastName: partes.slice(1).join(" ") };
}

/**
 * +55 91 98164-1754 → { areaCode: "91", number: "981641754" }. Só telefone
 * brasileiro em E.164; qualquer outra forma devolve null (melhor omitir do
 * que mandar um DDD errado).
 */
export function splitPhoneBR(phoneE164: string): { areaCode: string; number: string } | null {
  const digitos = phoneE164.replace(/\D/g, "");
  if (!digitos.startsWith("55")) return null;
  const nacional = digitos.slice(2);
  if (nacional.length !== 10 && nacional.length !== 11) return null;
  return { areaCode: nacional.slice(0, 2), number: nacional.slice(2) };
}

/** Monta o comprador com tudo o que a loja tiver — e só com isso. */
export function buildCheckoutPayer(
  customer: PayerCustomer,
  shippingAddress?: unknown,
): CheckoutPayerData {
  const nome = limpo(customer.fullName) ?? "";
  const { firstName, lastName } = splitName(nome);

  const email = limpo(customer.email);

  const numeroDoc = limpo(customer.documentNumber)?.replace(/\D/g, "") ?? null;
  // O tipo gravado pode vir em qualquer caixa; CNPJ tem 14 dígitos, CPF 11.
  const tipoDoc = limpo(customer.documentType)?.toUpperCase();
  const document =
    numeroDoc && (numeroDoc.length === 11 || numeroDoc.length === 14)
      ? {
          type: (tipoDoc === "CNPJ" || numeroDoc.length === 14 ? "CNPJ" : "CPF") as "CPF" | "CNPJ",
          number: numeroDoc,
        }
      : undefined;

  const telefone = limpo(customer.phoneE164);
  const phone = telefone ? (splitPhoneBR(telefone) ?? undefined) : undefined;

  const endereco = (shippingAddress ?? null) as PayerAddress | null;
  const cep = limpo(endereco?.postalCode)?.replace(/\D/g, "") ?? null;
  const rua = limpo(endereco?.street);
  const numeroCasa = limpo(endereco?.number);
  const address =
    cep && cep.length === 8 && rua
      ? { zipCode: cep, streetName: rua, streetNumber: numeroCasa ?? "s/n" }
      : undefined;

  return {
    firstName,
    lastName,
    ...(email ? { email } : {}),
    ...(document ? { document } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
  };
}
