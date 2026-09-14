// O prompt do Ateliê — PURO e determinístico (sem data, sem aleatório). É
// outra inteligência, não a Lia: lê o recado da dona (e as fotos) e devolve
// a proposta da chegada no formato de ARRIVAL_JSON_SCHEMA.
import { CARE_SYMBOL_KEYS, CARE_SYMBOLS } from "@/core/catalog/care";
import { DRAFT_MAX_COLORS, DRAFT_MAX_SIZES } from "@/core/catalog/product-draft";

import { NUMERIC_SIZE_MAX, NUMERIC_SIZE_MIN, SIZE_ORDER } from "./proposal";

export type ArrivalPromptInput = {
  storeName: string;
  manifesto: string;
  categories: readonly { name: string; slug: string }[];
  knownColors: readonly string[];
  knownSizes: readonly string[];
  knownSuppliers: readonly string[];
};

export function buildArrivalPrompt(input: ArrivalPromptInput): string {
  const salas =
    input.categories.length > 0
      ? input.categories.map((category) => `- ${category.name} (slug: ${category.slug})`).join("\n")
      : "- (nenhuma sala cadastrada: devolva categorySlug null)";
  const cores = input.knownColors.length > 0 ? input.knownColors.join(", ") : "(nenhuma ainda)";
  const tamanhos = input.knownSizes.length > 0 ? input.knownSizes.join(", ") : "(nenhum ainda)";
  const fornecedores = input.knownSuppliers.length > 0 ? input.knownSuppliers.join(", ") : "(nenhum cadastrado)";
  const cuidados = CARE_SYMBOL_KEYS.map((key) => `${key} = ${CARE_SYMBOLS[key].label}`).join("; ");
  return [
    `Você é o ateliê da loja ${input.storeName}: a dona acabou de receber uma peça, fotografou e mandou um recado curto por WhatsApp (texto ou áudio transcrito). Sua tarefa é transformar o RECADO (fonte principal) e as FOTOS (apoio) na ficha de chegada. Devolva SOMENTE o JSON pedido.`,
    input.manifesto.trim() !== ""
      ? `TOM DA LOJA (use no nome e na descrição):\n${input.manifesto.trim()}`
      : "TOM DA LOJA: elegante, direto, caloroso; sem exageros nem jargão de e-commerce.",
    `SALAS (categorias) da loja — escolha UMA pelo slug, ou null:\n${salas}`,
    `CORES já usadas na loja (prefira estas grafias): ${cores}.\nTAMANHOS já usados: ${tamanhos}.\nFORNECEDORES cadastrados (prefira estas grafias em supplierName): ${fornecedores}.`,
    `REGRAS:\n1. name: o nome que a dona deu no recado ("chegou o Longo Dunas" → "Longo Dunas"); sem nome no recado, um nome curto no tom da loja a partir das fotos. Até 80 caracteres, sem cor nem preço.\n2. colors: as cores DITAS no recado ("areia e terra" → ["Areia", "Terra"]); só use as fotos quando o recado não falar de cor. Até ${DRAFT_MAX_COLORS}, Primeira letra maiúscula.\n3. sizes: os tamanhos DITOS, já expandidos na ordem ${SIZE_ORDER.join(", ")} ou numéricos de ${NUMERIC_SIZE_MIN} a ${NUMERIC_SIZE_MAX} de 2 em 2 ("do P ao GG" → ["P","M","G","GG"]; "36 ao 42" → ["36","38","40","42"]). Até ${DRAFT_MAX_SIZES}. Sem tamanho no recado nem na etiqueta, devolva [] — nunca chute. Repita a faixa dita em sizeRange.\n4. quantityPerVariant: "três de cada" = 3 (por combinação cor × tamanho); totalQuantity só quando ela disse o TOTAL ("vieram 20 peças"). Sem número, null.\n5. costCents: o custo em CENTAVOS ("custou 120" = 12000; "120 cada" = 12000 por peça; "1.200 o lote" = 120000 total). costBasis: per_piece quando é por peça ("cada", "a unidade", ou um valor pequeno compatível com uma peça), total quando é o lote inteiro ("o lote", "tudo", "no total"), unknown se não dá para saber.\n6. supplierName: o fornecedor citado ("da Aurora" → "Aurora"); prefira a grafia da lista; null se não citado.\n7. description: pelo menos 300 caracteres em pt-BR, falando de tecido, caimento, ocasião e UMA frase sobre o calor e a umidade de Belém. Nunca invente tecnologia de tecido nem origem.\n8. composition: só o que está legível na etiqueta ou dito no recado; senão "". careSymbols só os pictogramas lidos, usando as chaves: ${cuidados}. fitNotes: caimento, modelagem e comprimento observáveis.\n9. weightGramsEstimate: estimativa honesta em gramas, ou null.\n10. warnings: tudo que ficou em dúvida (ex.: "Não disse tamanhos", "Custo pode ser o total"), em frases curtas em pt-BR.`,
  ].join("\n\n");
}

/** Texto do turno: o recado da dona, tal qual (a transcrição já veio limpa). */
export function arrivalUserText(note: string): string {
  const trimmed = note.trim();
  return trimmed === ""
    ? "A dona mandou só as fotos, sem recado. Monte a ficha pelo que dá para ver e deixe cores/tamanhos vazios se não aparecerem."
    : `RECADO DA DONA: "${trimmed}"\n\nFotos da chegada em anexo (quando houver). Devolva o JSON.`;
}
