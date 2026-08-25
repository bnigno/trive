import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthUser = {
  id: string;
  email: string;
  fullName: string | null;
  role: "owner" | "staff";
};

// Guard por layout + por action (sem middleware). `cache` deduplica a
// verificação dentro de um mesmo request (layout + page + action).
export const requireUser = cache(async (): Promise<AuthUser> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect("/admin/login");
  }

  const db = getDb();
  const [record] = await db
    .select()
    .from(users)
    .where(eq(users.id, data.user.id))
    .limit(1);

  if (!record) {
    // Sessão válida no Supabase, mas sem cadastro na tabela users:
    // não autorizado — a tela de login explica o motivo.
    redirect("/admin/login?motivo=nao-autorizado");
  }

  if (!record.isActive) {
    redirect("/admin/login?motivo=inativo");
  }

  return {
    id: record.id,
    email: record.email,
    fullName: record.fullName,
    role: record.role === "owner" ? "owner" : "staff",
  };
});
