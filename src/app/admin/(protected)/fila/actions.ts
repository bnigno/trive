"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { auditLog, outboxEvents } from "@/db/schema";
import { requireUser } from "@/services/auth";

const eventIdSchema = z.uuid();

export async function requeueDeadEvent(formData: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = eventIdSchema.safeParse(formData.get("id"));
  if (!parsed.success) return;
  const id = parsed.data;

  const db = getDb();
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, id))
      .limit(1);
    if (!before || before.status !== "dead") return;

    await tx
      .update(outboxEvents)
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      })
      .where(eq(outboxEvents.id, id));

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      action: "requeue",
      entityType: "outbox_event",
      entityId: id,
      before: {
        status: before.status,
        attempts: before.attempts,
        lastError: before.lastError,
      },
      after: { status: "pending", attempts: 0, lastError: null },
    });
  });

  revalidatePath("/admin/fila");
}

export async function discardDeadEvent(formData: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = eventIdSchema.safeParse(formData.get("id"));
  if (!parsed.success) return;
  const id = parsed.data;

  const db = getDb();
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, id))
      .limit(1);
    if (!before || before.status !== "dead") return;

    await tx
      .update(outboxEvents)
      .set({ status: "done", processedAt: new Date() })
      .where(eq(outboxEvents.id, id));

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      action: "discard",
      entityType: "outbox_event",
      entityId: id,
      before: {
        status: before.status,
        attempts: before.attempts,
        lastError: before.lastError,
      },
      after: { status: "done" },
    });
  });

  revalidatePath("/admin/fila");
}
