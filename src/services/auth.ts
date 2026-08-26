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

type AuthResolution =
  | { user: AuthUser }
  | { user: null; reason: "sem_sessao" | "nao_autorizado" | "inativo" };

// Resolvedor único da sessão. `cache` deduplica a verificação dentro de um
// mesmo request (layout + page + action + route handler), inclusive quando
// requireUser e getAuthUserOrNull são chamados juntos.
const resolveAuthUser = cache(async (): Promise<AuthResolution> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return { user: null, reason: "sem_sessao" };
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
    return { user: null, reason: "nao_autorizado" };
  }

  if (!record.isActive) {
    return { user: null, reason: "inativo" };
  }

  return {
    user: {
      id: record.id,
      email: record.email,
      fullName: record.fullName,
      role: record.role === "owner" ? "owner" : "staff",
    },
  };
});

// Guard por layout + por action (sem middleware): sem sessão válida,
// redireciona para o login com o motivo.
export async function requireUser(): Promise<AuthUser> {
  const resolution = await resolveAuthUser();
  if (resolution.user) return resolution.user;

  if (resolution.reason === "nao_autorizado") {
    redirect("/admin/login?motivo=nao-autorizado");
  }
  if (resolution.reason === "inativo") {
    redirect("/admin/login?motivo=inativo");
  }
  redirect("/admin/login");
}

/**
 * Variante para route handlers JSON (ex.: poll do chat): nunca redireciona —
 * devolve null e o handler responde 401 no formato que o cliente espera.
 */
export async function getAuthUserOrNull(): Promise<AuthUser | null> {
  const resolution = await resolveAuthUser();
  return resolution.user;
}
