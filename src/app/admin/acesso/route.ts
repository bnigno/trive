// Porta de entrada dos links de acesso (convite e recuperação de senha).
//
// POR QUE token_hash + verifyOtp, e não o link do vendor: o cliente
// `@supabase/ssr` está fixado no fluxo PKCE, enquanto o `action_link` que o
// GoTrue devolve é do fluxo implícito — cair aqui com ele lança erro. Com o
// token hasheado a validação acontece TODA no servidor, então o link também
// funciona quando a pessoa abre o e-mail no celular e o painel no computador.
import { redirect } from "next/navigation";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  token_hash: z.string().min(1),
  type: z.enum(["invite", "recovery"]),
});

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = paramsSchema.safeParse({
    token_hash: params.get("token_hash"),
    type: params.get("type"),
  });

  if (!parsed.success) {
    redirect("/admin/login?motivo=link-invalido");
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    type: parsed.data.type,
    token_hash: parsed.data.token_hash,
  });

  if (error) {
    // Motivo real (expirado, já usado, adulterado) fica no log: para quem
    // está na tela a saída é a mesma — pedir um link novo.
    console.warn("[acesso] link de acesso recusado:", error.message);
    redirect("/admin/login?motivo=link-invalido");
  }

  // A sessão já está nos cookies. Convite ganha a copy de primeira senha.
  redirect(
    parsed.data.type === "invite"
      ? "/admin/nova-senha?primeiro=1"
      : "/admin/nova-senha",
  );
}
