// O texto que a dona escreve para a Lia ("tom e fatos da loja") entra no
// prompt SUBORDINADO ao método e às regras duras. Quando ele pede algo que a
// Lia não pode cumprir, o painel avisa na hora — em vez de a Lia obedecer ora
// um, ora outro. PURO.

const BRAND_WORD = /\bmaison\b/iu;

/** "maison" no texto da dona: a loja se chama TRIVÉ (só a tagline e o domínio guardam a palavra). */
export function brandWordWarning(text: string): string | null {
  return BRAND_WORD.test(text) ? 'A Lia nunca chama a loja de "maison" — escreva TRIVÉ.' : null;
}

/** Avisos em pt-BR para o painel quando o texto contradiz o método da Lia. Vazio = ok. */
export function ownerTextWarnings(text: string): string[] {
  const warnings: string[] = [];
  const normalized = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/\bnome\b/u.test(normalized) && /pergunt|chame|chamar|trate|trata-la|chama-la/u.test(normalized)) {
    warnings.push(
      "Este texto pede o nome da cliente. A Lia nunca pergunta o nome: usa o do WhatsApp quando existe e só pede o nome completo no cadastro. Tire essa parte — o método dela vale por cima.",
    );
  }
  if (/desconto|promo[cç][aã]o|promocional|cupom de/u.test(normalized)) {
    warnings.push("Desconto só existe por cupom validado no sistema: promessa de desconto aqui a Lia não consegue cumprir.");
  }
  const brand = brandWordWarning(text);
  if (brand) warnings.push(brand);
  return warnings;
}
