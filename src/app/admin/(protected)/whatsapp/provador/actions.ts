"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { spDateTime, spDayKey } from "@/lib/sp-day";
import { requireOwner } from "@/services/auth";
import {
  applyHouseRules,
  cancelGroupPost,
  closeGroupPoll,
  composeGroupPost,
  type ComposeGroupPostInput,
  loadGroupPolicy,
  pauseGroup,
  refreshInvitationLink,
  registerGroup,
  resumeGroup,
  scheduleGroupPost,
  setGroupActive,
  syncGroupMembers,
} from "@/services/wa-groups";

export type FormState = { error?: string; success?: string; preview?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ServiceError") return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  if (error instanceof Error && /Z-API/.test(error.message)) return `O WhatsApp da loja não respondeu (${error.message}).`;
  return "Algo deu errado, tente novamente.";
}

function revalidate(groupId?: string): void {
  revalidatePath("/admin/whatsapp/provador");
  if (groupId) revalidatePath(`/admin/whatsapp/provador/${groupId}`);
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

const registerSchema = z.object({ providerGroupId: z.string().trim().min(1, "Escolha um grupo.") });

export async function registerGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const parsed = registerSchema.parse({ providerGroupId: formData.get("providerGroupId") ?? "" });
    const group = await registerGroup(getDb(), getMessagingProvider(), { providerGroupId: parsed.providerGroupId, userId: user.id });
    revalidate(group.id);
    return { success: `Sala "${group.name}" registrada com ${group.memberCount} ${group.memberCount === 1 ? "membra" : "membras"}.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

const groupIdSchema = z.object({ groupId: z.uuid() });

export async function syncGroupAction(formData: FormData): Promise<void> {
  await requireOwner("whatsapp");
  const { groupId } = groupIdSchema.parse({ groupId: formData.get("groupId") });
  await syncGroupMembers(getDb(), getMessagingProvider(), { groupId });
  revalidate(groupId);
}

export async function houseRulesAction(formData: FormData): Promise<void> {
  const user = await requireOwner("whatsapp");
  const { groupId } = groupIdSchema.parse({ groupId: formData.get("groupId") });
  await applyHouseRules(getDb(), getMessagingProvider(), { groupId, userId: user.id });
  await refreshInvitationLink(getDb(), getMessagingProvider(), { groupId });
  revalidate(groupId);
}

export async function refreshLinkAction(formData: FormData): Promise<void> {
  await requireOwner("whatsapp");
  const { groupId } = groupIdSchema.parse({ groupId: formData.get("groupId") });
  await refreshInvitationLink(getDb(), getMessagingProvider(), { groupId });
  revalidate(groupId);
}

const pauseSchema = groupIdSchema.extend({ days: z.coerce.number().int().min(1).max(30).default(7) });

export async function pauseGroupAction(formData: FormData): Promise<void> {
  const user = await requireOwner("whatsapp");
  const { groupId, days } = pauseSchema.parse({ groupId: formData.get("groupId"), days: formData.get("days") ?? 7 });
  await pauseGroup(getDb(), {
    groupId,
    until: new Date(Date.now() + days * 86_400_000),
    reason: "pausada pela dona",
    actor: { type: "user", id: user.id },
  });
  revalidate(groupId);
}

export async function resumeGroupAction(formData: FormData): Promise<void> {
  const user = await requireOwner("whatsapp");
  const { groupId } = groupIdSchema.parse({ groupId: formData.get("groupId") });
  await resumeGroup(getDb(), { groupId, userId: user.id });
  revalidate(groupId);
}

const activeSchema = groupIdSchema.extend({ nextActive: z.enum(["true", "false"]) });

export async function setGroupActiveAction(formData: FormData): Promise<void> {
  const user = await requireOwner("whatsapp");
  const { groupId, nextActive } = activeSchema.parse({ groupId: formData.get("groupId"), nextActive: formData.get("nextActive") });
  await setGroupActive(getDb(), { groupId, isActive: nextActive === "true", userId: user.id });
  revalidate(groupId);
}

// ---------------------------------------------------------------------------
// Posts — pré-visualizar e agendar (o mesmo form, dois botões)
// ---------------------------------------------------------------------------

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value));

const composeFormSchema = z.object({
  groupId: z.uuid(),
  intent: z.enum(["preview", "schedule"]),
  kind: z.enum(["chegadas", "enquete", "quem_vestiu", "livre"]),
  /** 'YYYY-MM-DD' + 'HH:MM' no relógio de SP; vazio = agora. */
  day: z.string().trim(),
  time: z.string().trim(),
  productIds: z.array(z.uuid()).default([]),
  vitrineWhen: optionalText,
  question: z.string().trim().default(""),
  options: z.string().default(""),
  maxOptions: z.coerce.number().int().min(1).max(12).default(1),
  outcome: optionalText,
  voterHoldHours: z.coerce.number().int().min(0).max(168).default(24),
  lookIds: z.array(z.uuid()).default([]),
  photoCoupon: z.enum(["on"]).optional(),
  body: z.string().default(""),
  imageUrl: optionalText,
});

function readComposeForm(formData: FormData): z.infer<typeof composeFormSchema> {
  return composeFormSchema.parse({
    groupId: formData.get("groupId"),
    intent: formData.get("intent"),
    kind: formData.get("kind"),
    day: formData.get("day") ?? "",
    time: formData.get("time") ?? "",
    productIds: formData.getAll("productIds").map(String).filter((value) => value !== ""),
    vitrineWhen: formData.get("vitrineWhen") ?? "",
    question: formData.get("question") ?? "",
    options: formData.get("options") ?? "",
    maxOptions: formData.get("maxOptions") || 1,
    outcome: formData.get("outcome") ?? "",
    voterHoldHours: formData.get("voterHoldHours") || 24,
    lookIds: formData.getAll("lookIds").map(String).filter((value) => value !== ""),
    photoCoupon: formData.get("photoCoupon") ?? undefined,
    body: formData.get("body") ?? "",
    imageUrl: formData.get("imageUrl") ?? "",
  });
}

function toComposeInput(form: z.infer<typeof composeFormSchema>): ComposeGroupPostInput {
  switch (form.kind) {
    case "chegadas":
      return { kind: "chegadas", productIds: form.productIds, ...(form.vitrineWhen ? { vitrineWhen: form.vitrineWhen } : {}) };
    case "enquete":
      return {
        kind: "enquete",
        question: form.question,
        options: form.options
          .split(/\r?\n/)
          .map((option) => option.trim())
          .filter((option) => option !== ""),
        maxOptions: form.maxOptions,
        ...(form.outcome ? { outcome: form.outcome } : {}),
        voterHoldHours: form.voterHoldHours,
      };
    case "quem_vestiu":
      return { kind: "quem_vestiu", lookIds: form.lookIds, photoCoupon: form.photoCoupon === "on" };
    case "livre":
      return { kind: "livre", body: form.body, ...(form.imageUrl ? { imageUrl: form.imageUrl } : {}) };
  }
}

/** A hora marcada no relógio de SP; null = agora. Dia sem hora vale 10h. */
function toScheduledAt(form: { day: string; time: string }): Date | null {
  if (form.day === "") return null;
  const [hh, mm] = (form.time || "10:00").split(":").map(Number);
  return spDateTime(form.day, (hh ?? 10) * 60 + (mm ?? 0));
}

export async function composePostAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const form = readComposeForm(formData);
    const db = getDb();
    const scheduledAt = toScheduledAt(form);
    const post = toComposeInput(form);
    if (form.intent === "preview") {
      const policy = await loadGroupPolicy(db);
      const composed = await composeGroupPost(db, post, { day: spDayKey(scheduledAt ?? new Date()), holdHours: policy.holdHours });
      const preview = composed.pollOptions ? `${composed.body}\n\n${composed.pollOptions.map((option) => `○ ${option}`).join("\n")}` : composed.body;
      return { preview };
    }
    const scheduled = await scheduleGroupPost(db, { groupId: form.groupId, scheduledAt, userId: user.id, post });
    revalidate(form.groupId);
    return {
      success: scheduled.scheduledAt && scheduled.scheduledAt.getTime() > Date.now() + 60_000 ? "Post agendado. Ele sai na hora marcada, dentro da janela." : "Post enviado para a fila — sai em instantes.",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

const postIdSchema = z.object({ postId: z.uuid(), groupId: z.uuid() });

export async function cancelPostAction(formData: FormData): Promise<void> {
  const user = await requireOwner("whatsapp");
  const { postId, groupId } = postIdSchema.parse({ postId: formData.get("postId"), groupId: formData.get("groupId") });
  await cancelGroupPost(getDb(), { postId, userId: user.id });
  revalidate(groupId);
}

export async function closePollAction(formData: FormData): Promise<void> {
  await requireOwner("whatsapp");
  const { postId, groupId } = postIdSchema.parse({ postId: formData.get("postId"), groupId: formData.get("groupId") });
  await closeGroupPoll(getDb(), getMessagingProvider(), { postId });
  revalidate(groupId);
}
