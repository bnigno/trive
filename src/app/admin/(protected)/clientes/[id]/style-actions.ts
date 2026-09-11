"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { forgetStyleProfile } from "@/services/style-profiles";

export async function forgetStyleProfileAdminAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const profileId = z.uuid().parse(formData.get("profileId"));
  const customerId = String(formData.get("customerId") ?? "");
  await forgetStyleProfile(getDb(), { profileId, userId: user.id });
  if (customerId) revalidatePath(`/admin/clientes/${customerId}`);
}
