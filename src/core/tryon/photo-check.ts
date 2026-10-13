// "Me vê com ela" — a checagem da foto da cliente ANTES de gastar crédito.
// PURO: o prompt da visão, o JSON pedido e a regra que decide se a foto
// serve para a peça escolhida. A visão só descreve a foto (quantas pessoas,
// quanto do corpo aparece, o que veste da cintura para baixo); quem decide
// é photoCheckVerdict — o limiar fica no código, não no modelo.
import { z } from "zod";

import type { StudioGarmentCategory } from "@/core/studio/prompts";

import { requiredFraming, type TryOnPhotoProblem } from "./rules";

export const PHOTO_CHECK_SYSTEM_PROMPT = `Você confere fotos para a TRIVÉ, uma loja de moda feminina em Belém do Pará.
A cliente mandou UMA foto dela para ver uma roupa da loja no próprio corpo (prévia feita com IA). Antes de gerar, descreva a foto respondendo SÓ o JSON pedido.
Não avalie nem comente corpo, rosto, beleza ou idade aparente além do que o JSON pede.

Campos:
- pessoas: quantas pessoas aparecem EM DESTAQUE (gente pequena ao fundo, como banhistas distantes, não conta).
- foto_de_pessoa_real: é uma foto de verdade de uma pessoa? (false para desenho, montagem, print de tela de outra coisa, foto só de roupa ou de manequim).
- adulta: a pessoa em destaque é claramente adulta? Na dúvida, false.
- sem_roupa: há nudez (seios ou genitais à mostra)? Biquíni, maiô, lingerie e roupa de ginástica NÃO são nudez.
- corpo_visivel: até onde o corpo aparece, da cabeça para baixo: "cabeca_aos_pes", "ate_joelhos", "ate_coxas" (até o meio das coxas), "ate_cintura" ou "so_rosto". Celular na frente do rosto (foto no espelho) não muda isso.
- parte_de_baixo: o que ela veste da cintura para baixo: "roupa" (calça, saia, short, vestido, ou canga/saída de praia amarrada cobrindo o quadril), "roupa_de_banho_ou_intima" (biquíni ou calcinha à mostra) ou "nao_aparece".`;

export const PHOTO_CHECK_USER_TEXT = "Descreva esta foto no JSON pedido.";

const CORPO_VISIVEL = ["cabeca_aos_pes", "ate_joelhos", "ate_coxas", "ate_cintura", "so_rosto"] as const;
const PARTE_DE_BAIXO = ["roupa", "roupa_de_banho_ou_intima", "nao_aparece"] as const;

export const PHOTO_CHECK_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    // A saída estruturada não aceita minimum/maximum em inteiro: o intervalo fica no Zod.
    pessoas: { type: "integer" },
    foto_de_pessoa_real: { type: "boolean" },
    adulta: { type: "boolean" },
    sem_roupa: { type: "boolean" },
    corpo_visivel: { type: "string", enum: [...CORPO_VISIVEL] },
    parte_de_baixo: { type: "string", enum: [...PARTE_DE_BAIXO] },
  },
  required: ["pessoas", "foto_de_pessoa_real", "adulta", "sem_roupa", "corpo_visivel", "parte_de_baixo"],
  additionalProperties: false,
};

export const photoCheckSchema = z.object({
  pessoas: z.number().int().min(0).max(50),
  foto_de_pessoa_real: z.boolean(),
  adulta: z.boolean(),
  sem_roupa: z.boolean(),
  corpo_visivel: z.enum(CORPO_VISIVEL),
  parte_de_baixo: z.enum(PARTE_DE_BAIXO),
});

export type PhotoCheck = z.infer<typeof photoCheckSchema>;

/** Do mais ao menos corpo: a foto serve se mostra pelo menos o que a peça pede. */
const FRAMING_RANK: Record<PhotoCheck["corpo_visivel"], number> = {
  cabeca_aos_pes: 4,
  ate_joelhos: 3,
  ate_coxas: 2,
  ate_cintura: 1,
  so_rosto: 0,
};
const FRAMING_NEEDED = { ate_coxas: 2, ate_cintura: 1 } as const;

export type PhotoCheckVerdict = { ok: true } | { ok: false; problem: TryOnPhotoProblem };

/**
 * A ordem importa: primeiro o que nunca pode (não é foto, não é UMA pessoa,
 * menor, nudez), depois o que outra foto resolve (enquadramento, blusa sobre
 * biquíni — a IA troca só a parte de cima e a de baixo continua lá).
 */
export function photoCheckVerdict(check: PhotoCheck, category: StudioGarmentCategory): PhotoCheckVerdict {
  if (!check.foto_de_pessoa_real) return { ok: false, problem: "nao_e_foto" };
  if (check.pessoas === 0) return { ok: false, problem: "sem_pessoa" };
  if (check.pessoas > 1) return { ok: false, problem: "mais_de_uma_pessoa" };
  if (!check.adulta || check.sem_roupa) return { ok: false, problem: "nao_pode" };
  if (FRAMING_RANK[check.corpo_visivel] < FRAMING_NEEDED[requiredFraming(category)]) return { ok: false, problem: "enquadramento" };
  if (category === "tops" && check.parte_de_baixo === "roupa_de_banho_ou_intima") return { ok: false, problem: "parte_de_baixo" };
  return { ok: true };
}
