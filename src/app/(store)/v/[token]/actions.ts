"use server";
// A votação das amigas (/v/<token>): o voto, o recado depois do voto e a
// ponte "quero ver peças no meu estilo". Sem login e sem telefone: o
// aparelho manda um identificador aleatório (só o hash vai para o banco).
import { z } from "zod";

import { getDb } from "@/db/client";
import { addNoteToVote, openRoundBridge, voteInRound, type NoteResult, type VoteResult } from "@/services/friend-rounds";

const tokenSchema = z.string().trim().min(8).max(40);

const voteSchema = z.object({
  token: tokenSchema,
  choice: z.number().int().min(0).max(2),
  voterId: z.uuid(),
});

export async function voteAction(input: z.input<typeof voteSchema>): Promise<VoteResult> {
  const parsed = voteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "opcao_invalida" };
  try {
    return await voteInRound(getDb(), { ...parsed.data, now: new Date() });
  } catch (error) {
    console.error("[v] voto não gravado", error);
    return { ok: false, reason: "inexistente" };
  }
}

const noteSchema = z.object({
  token: tokenSchema,
  voterId: z.uuid(),
  note: z.string().max(500),
  nickname: z.string().max(100).optional(),
});

export async function noteAction(input: z.input<typeof noteSchema>): Promise<NoteResult> {
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "vazio" };
  try {
    return await addNoteToVote(getDb(), { ...parsed.data, now: new Date() });
  } catch (error) {
    console.error("[v] recado não gravado", error);
    return { ok: false, reason: "inexistente" };
  }
}

const bridgeSchema = z.object({ token: tokenSchema });

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
