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
  /** Endereço marcado como padrão no cadastro (só informativo para o modelo). */
  isDefault?: boolean;
};

export type SavedRegistration = {
  fullName: string;
  documentDigits: string | null;
  /** Todos os endereços salvos: o padrão primeiro, depois do mais recente. */
  addresses: SavedAddress[];
};

/** Quantos endereços salvos o modelo vê (o resto não cabe numa pergunta). */
export const SAVED_ADDRESSES_MAX = 3;

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

function cepDigits(address: SavedAddress): string {
  return (address.postalCode ?? "").replace(/\D/g, "");
}

export type SavedAddressPick =
  | { kind: "one"; address: SavedAddress }
  | { kind: "none"; usable: SavedAddress[] }
  | { kind: "ambiguous"; matches: SavedAddress[] };

/**
 * Qual endereço salvo é o da entrega, dado o CEP cotado nesta conversa.
 * Só endereços completos contam. Com CEP cotado: o único salvo com esse CEP
 * (dois iguais = ambíguo, o modelo confirma qual). Sem CEP cotado: um único
 * endereço usável serve; dois ou mais exigem que a cliente diga qual.
 */
export function pickSavedAddressForCep(
  addresses: readonly SavedAddress[],
  quotedCep: string | undefined,
): SavedAddressPick {
  const usable = addresses.filter(isAddressUsable);
  const cep = (quotedCep ?? "").replace(/\D/g, "");
  if (cep !== "") {
    const matches = usable.filter((address) => cepDigits(address) === cep);
    if (matches.length === 1) return { kind: "one", address: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", matches };
    return { kind: "none", usable };
  }
  if (usable.length === 1) return { kind: "one", address: usable[0] };
  return { kind: "none", usable };
}

/**
 * Linhas numeradas dos endereços salvos, com CEP em evidência: o modelo
 * precisa citar o CEP certo em cotar_frete. Marca o padrão e o que já foi
 * cotado nesta conversa.
 */
export function formatSavedAddressLines(
  addresses: readonly SavedAddress[],
  opts: { quotedCep?: string | undefined } = {},
): string[] {
  const cep = (opts.quotedCep ?? "").replace(/\D/g, "");
  return addresses.slice(0, SAVED_ADDRESSES_MAX).map((address, index) => {
    const texto = formatSavedAddress(address) ?? "(endereço sem dados)";
    const marcas = [
      address.isDefault ? "padrão" : null,
      !isAddressUsable(address) ? "incompleto" : null,
      cep !== "" && cepDigits(address) === cep ? "CEP já cotado nesta conversa" : null,
    ].filter((marca): marca is string => marca !== null);
    return `${index + 1}. ${texto}${marcas.length > 0 ? ` (${marcas.join("; ")})` : ""}`;
  });
}

/**
 * Bloco pt-BR que a ferramenta devolve à IA. O texto entre colchetes é
 * instrução para o modelo, não fala do cliente — mesmo padrão já usado por
 * listar_produtos quando envia o menu interativo.
 *
 * O endereço é a parte delicada: a cliente pode ter mais de um salvo, e o
 * frete só vale para o CEP cotado. Por isso cada endereço vai com o CEP e a
 * instrução manda confirmar QUAL antes de cotar.
 */
export function summarizeRegistration(
  registration: SavedRegistration,
  opts: { quotedCep?: string | undefined } = {},
): string {
  const linhas = [`• Nome: ${registration.fullName}`];

  const documento = maskDocument(registration.documentDigits);
  if (documento) linhas.push(`• CPF: ${documento}`);

  const enderecos = registration.addresses;
  const usaveis = enderecos.filter(isAddressUsable);
  const cep = (opts.quotedCep ?? "").replace(/\D/g, "");
  const cotadoBate = cep !== "" && usaveis.some((address) => cepDigits(address) === cep);

  if (enderecos.length === 1) {
    const texto = formatSavedAddress(enderecos[0]);
    if (texto) linhas.push(`• Endereço: ${texto}`);
  } else if (enderecos.length > 1) {
    linhas.push(
      `• Endereços salvos (${enderecos.length}${enderecos.length > SAVED_ADDRESSES_MAX ? `, mostrando ${SAVED_ADDRESSES_MAX}` : ""}):`,
      ...formatSavedAddressLines(enderecos, { quotedCep: cep }),
    );
  }
  if (cep !== "" && !cotadoBate) {
    linhas.push(
      `• ATENÇÃO: o CEP cotado nesta conversa (${cep.slice(0, 5)}-${cep.slice(5)}) não é de nenhum endereço salvo.`,
    );
  }

  const cabecalho = "Encontrei o cadastro deste cliente:";
  const outroEndereco =
    "Se a entrega for em OUTRO endereço, colete-o e passe COMPLETO nos campos (cep, rua, numero, bairro, cidade, uf) junto com usar_cadastro_salvo true — nome e CPF continuam do cadastro.";
  let instrucao: string;
  if (usaveis.length === 0) {
    instrucao = `[O endereço salvo está incompleto para entrega: confirme o nome com o cliente e colete o endereço normalmente, um dado por vez. Feche passando o endereço COMPLETO nos campos junto com usar_cadastro_salvo true (nome e CPF continuam do cadastro — NÃO peça o CPF de novo).]`;
  } else if (usaveis.length === 1 && enderecos.length === 1) {
    const cepSalvo = cepDigits(usaveis[0]);
    instrucao = `[Confirme ESTES dados com o cliente em UMA pergunta de sim ou não. Com o SIM: chame cotar_frete com o CEP ${cepSalvo} (se ainda não cotou esse CEP para a sacola atual), apresente o resumo e feche com criar_pedido usar_cadastro_salvo true — NÃO peça nome, CPF nem endereço de novo. ${outroEndereco}]`;
  } else {
    instrucao = `[Pergunte em UMA mensagem EM QUAL destes endereços é a entrega (ou se é outro). Depois chame cotar_frete com o CEP do endereço escolhido (se ainda não cotou esse CEP para a sacola atual), apresente o resumo e feche com criar_pedido usar_cadastro_salvo true — o serviço usa o endereço salvo cujo CEP foi cotado. NÃO peça nome nem CPF de novo. ${outroEndereco}]`;
  }

  return [cabecalho, ...linhas, "", instrucao].join("\n");
}
