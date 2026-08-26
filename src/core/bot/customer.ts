// Cadastro do cliente no atendimento do WhatsApp — PURO.
//
// A regra que molda este arquivo: o CPF NUNCA circula pelo modelo. A IA recebe
// só o que o cliente precisa para dizer "sim, sou eu" (nome, fim do CPF,
// endereço); os dados reais o serviço lê do banco na hora de criar o pedido.
// Assim nem um vazamento de prompt nem uma mensagem mal formulada expõem o
// documento de alguém.

/** Endereço salvo, como o cadastro guarda (campos podem faltar em base antiga). */
export type SavedAddress = {
  postalCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
};

export type SavedRegistration = {
  fullName: string;
  documentDigits: string | null;
  address: SavedAddress | null;
};

/**
 * '52998224725' -> '•••.•••.•••-25'. Mostra os DOIS últimos dígitos: o bastante
 * para o cliente reconhecer o próprio documento, longe do bastante para alguém
 * reconstruí-lo. Mesmo espírito da máscara de telefone do painel.
 */
export function maskDocument(digits: string | null): string | null {
  const limpo = (digits ?? "").replace(/\D/g, "");
  if (limpo.length < 4) return null;
  return `•••.•••.•••-${limpo.slice(-2)}`;
}

/** 'Rua das Flores, 200 — Centro, Belém/PA · CEP 66000-000'. */
export function formatSavedAddress(address: SavedAddress | null): string | null {
  if (!address) return null;

  const rua = [address.street, address.number].filter(Boolean).join(", ");
  const comComplemento = address.complement
    ? `${rua} (${address.complement})`
    : rua;
  const cidadeUf = [address.city, address.state].filter(Boolean).join("/");
  const local = [address.district, cidadeUf].filter(Boolean).join(", ");

  const cep = (address.postalCode ?? "").replace(/\D/g, "");
  const cepFormatado =
    cep.length === 8 ? `CEP ${cep.slice(0, 5)}-${cep.slice(5)}` : null;

  const partes = [comComplemento, local].filter((p) => p !== "");
  if (partes.length === 0) return cepFormatado;

  const endereco = partes.join(" — ");
  return cepFormatado ? `${endereco} · ${cepFormatado}` : endereco;
}

/** O endereço salvo dá para entregar? Sem estes campos, o pedido não fecha. */
export function isAddressUsable(address: SavedAddress | null): boolean {
  if (!address) return false;
  const cep = (address.postalCode ?? "").replace(/\D/g, "");
  return (
    cep.length === 8 &&
    Boolean(address.street?.trim()) &&
    Boolean(address.number?.trim()) &&
    Boolean(address.district?.trim()) &&
    Boolean(address.city?.trim()) &&
    Boolean(address.state?.trim())
  );
}

/**
 * Bloco pt-BR que a ferramenta devolve à IA. O texto entre colchetes é
 * instrução para o modelo, não fala do cliente — mesmo padrão já usado por
 * listar_produtos quando envia o menu interativo.
 */
export function summarizeRegistration(registration: SavedRegistration): string {
  const linhas = [`• Nome: ${registration.fullName}`];

  const documento = maskDocument(registration.documentDigits);
  if (documento) linhas.push(`• CPF: ${documento}`);

  const endereco = formatSavedAddress(registration.address);
  const entregavel = isAddressUsable(registration.address);
  if (endereco) linhas.push(`• Endereço: ${endereco}`);

  const cabecalho = "Encontrei o cadastro deste cliente:";
  const instrucao = entregavel
    ? "[Confirme ESTES dados com o cliente em UMA pergunta de sim ou não. Se ele confirmar, chame criar_pedido com usar_cadastro_salvo true e NÃO peça nome, CPF nem endereço de novo. Se ele quiser mudar algo, colete só o que mudou e passe os campos normalmente.]"
    : "[O endereço salvo está incompleto para entrega: confirme o nome com o cliente e colete o endereço normalmente, um dado por vez. Não use usar_cadastro_salvo.]";

  return [cabecalho, ...linhas, "", instrucao].join("\n");
}
