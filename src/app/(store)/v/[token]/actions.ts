"use server";
// A votação das amigas (/v/<token>): o voto e a ponte "quero ver peças no meu
// estilo". Sem login e sem telefone: o aparelho manda um identificador
// aleatório (só o hash vai para o banco) e um campo-isca contra robôs.
import { z } from "zod";

import { getDb } from "@/db/client";
import { openRoundBridge, voteInRound, type VoteResult } from "@/services/friend-rounds";

const voteSchema = z.object({
  token: z.string().trim().min(8).max(40),
  choice: z.number().int().min(0).max(2),
  voterId: z.uuid(),
  note: z.string().max(500).optional(),
  nickname: z.string().max(100).optional(),
  /** Isca: gente não preenche (o campo é invisível). */
  website: z.string().max(0).optional(),
});

export async function voteAction(input: z.input<typeof voteSchema>): Promise<VoteResult> {
  const parsed = voteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "opcao_invalida" };
  if (parsed.data.website) return { ok: false, reason: "opcao_invalida" };
  try {
    return await voteInRound(getDb(), {
      token: parsed.data.token,
      choice: parsed.data.choice,
      voterId: parsed.data.voterId,
      note: parsed.data.note ?? null,
      nickname: parsed.data.nickname ?? null,
      now: new Date(),
    });
  } catch (error) {
    console.error("[v] voto não gravado", error);
    return { ok: false, reason: "inexistente" };
  }
}

const bridgeSchema = z.object({ token: z.string().trim().min(8).max(40) });

export async function bridgeAction(input: z.input<typeof bridgeSchema>): Promise<{ url: string | null }> {
  const parsed = bridgeSchema.safeParse(input);
  if (!parsed.success) return { url: null };
  try {
    return await openRoundBridge(getDb(), parsed.data);
  } catch (error) {
    console.error("[v] ponte não criada", error);
    return { url: null };
  }
}
