// Serviço de TEMPLATES de WhatsApp: o dono edita o texto das mensagens
// automáticas no admin. As keys são FIXAS (criadas pelo seed) — aqui só se
// edita corpo e ativa/inativa; `variables` é sempre recalculado a partir do
// corpo via extractVariables (nunca confiamos no que veio do formulário).
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { extractVariables } from "@/core/whatsapp/render";
import { auditLog, waTemplates } from "@/db/schema";
import { ServiceError, type ServiceDb } from "@/services/settings";

export { ServiceError };

export interface WaTemplate {
  key: string;
  label: string;
  bodyTemplate: string;
  variables: string[];
  isActive: boolean;
  updatedAt: Date;
}

/** Keys com prefixo owner_ são avisos internos ao dono; as demais vão ao cliente. */
export function isOwnerTemplate(key: string): boolean {
  return key.startsWith("owner_");
}

function toWaTemplate(row: typeof waTemplates.$inferSelect): WaTemplate {
  return {
    key: row.key,
    label: row.label,
    bodyTemplate: row.bodyTemplate,
    variables: Array.isArray(row.variables)
      ? (row.variables as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    isActive: row.isActive,
    updatedAt: row.updatedAt,
  };
}

/**
 * Todos os templates, ordenados para o admin: mensagens ao CLIENTE primeiro
 * (keys sem prefixo owner_), depois os avisos internos — cada grupo em ordem
 * alfabética de key (estável entre renders).
 */
export async function listWaTemplates(db: ServiceDb): Promise<WaTemplate[]> {
  const rows = await db.select().from(waTemplates).orderBy(asc(waTemplates.key));
  const customer = rows.filter((row) => !isOwnerTemplate(row.key));
  const internal = rows.filter((row) => isOwnerTemplate(row.key));
  return [...customer, ...internal].map(toWaTemplate);
}

const updateWaTemplateSchema = z.object({
  key: z.string().min(1),
  bodyTemplate: z
    .string()
    .trim()
    .min(10, "O texto da mensagem é curto demais — escreva pelo menos 10 caracteres."),
  isActive: z.boolean(),
  userId: z.uuid(),
});

export type UpdateWaTemplateInput = z.input<typeof updateWaTemplateSchema>;

/**
 * Edita um template EXISTENTE (nunca cria keys novas — os fluxos automáticos
 * dependem das keys do seed). Recalcula `variables` a partir do corpo salvo
 * e grava audit 'wa.template_update' com before/after.
 */
export async function updateWaTemplate(
  db: ServiceDb,
  input: UpdateWaTemplateInput,
): Promise<WaTemplate> {
  const parsed = updateWaTemplateSchema.parse(input);

  const saved = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(waTemplates)
      .where(eq(waTemplates.key, parsed.key))
      .limit(1);
    if (!current) {
      throw new ServiceError(
        "template_inexistente",
        `Modelo de mensagem desconhecido: "${parsed.key}". Não é possível criar modelos novos por aqui.`,
      );
    }

    const variables = extractVariables(parsed.bodyTemplate);

    const [row] = await tx
      .update(waTemplates)
      .set({
        bodyTemplate: parsed.bodyTemplate,
        variables,
        isActive: parsed.isActive,
        updatedAt: new Date(),
      })
      .where(eq(waTemplates.key, parsed.key))
      .returning();

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "wa.template_update",
      entityType: "wa_template",
      entityId: parsed.key,
      before: {
        bodyTemplate: current.bodyTemplate,
        variables: current.variables,
        isActive: current.isActive,
      },
      after: {
        bodyTemplate: parsed.bodyTemplate,
        variables,
        isActive: parsed.isActive,
      },
    });

    return row;
  });

  return toWaTemplate(saved);
}
