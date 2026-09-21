import { KeyRound, LogOut } from "lucide-react";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/services/auth";
import { getStoreName } from "@/services/settings";
import { Avatar } from "@/components/ui/avatar";
import { IconButton, IconButtonLink } from "@/components/ui/icon-button";
import { AdminBrand } from "./admin-brand";
import { AdminNotifier } from "./admin-notifier";
import { MobileNav } from "./mobile-nav";
import { AdminNav } from "./nav";
import { NotifyPrefsMenu } from "./notify-prefs-menu";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

/** O nome da loja é só a marca no topo: sem banco, o painel abre do mesmo jeito. */
async function loadStoreName(): Promise<string> {
  try {
    return await getStoreName(getDb());
  } catch {
    return STORE_NAME_DEFAULT;
  }
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, storeName] = await Promise.all([requireUser(), loadStoreName()]);

  // Navegação e rodapé de usuário são os mesmos na barra lateral (md+) e na
  // gaveta do celular — o dono opera a loja pelo telefone.
  const userFooter = (
    <div className="relative flex items-center gap-3 border-t border-white/10 p-3">
      <Avatar
        name={user.fullName}
        fallback={user.email}
        className="ring-1 ring-gold-400/60 ring-offset-1 ring-offset-noir-950"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-100">
          {user.fullName ?? user.email}
        </p>
        <p className="truncate text-xs text-zinc-500">
          {user.role === "owner" ? "Proprietário" : "Equipe"}
        </p>
      </div>
      <NotifyPrefsMenu />
      <IconButtonLink
        href="/admin/nova-senha"
        label="Minha senha"
        size="sm"
        variant="noir"
        icon={<KeyRound aria-hidden="true" className="size-4" strokeWidth={1.75} />}
      />
      <form action={signOut}>
        <IconButton
          type="submit"
          label="Sair"
          size="sm"
          variant="noir"
          icon={<LogOut aria-hidden="true" className="size-4" strokeWidth={1.75} />}
        />
      </form>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Uma instância só: poll leve, toasts, bipe e "(N)" no título, em qualquer página. */}
      <AdminNotifier />
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/10 bg-noir-950 text-zinc-400 md:flex">
        <div className="border-b border-white/10 px-5 py-4">
          <AdminBrand storeName={storeName} />
        </div>

        <AdminNav role={user.role} />
        {userFooter}
      </aside>

      <MobileNav storeName={storeName}>
        <AdminNav role={user.role} />
        {userFooter}
      </MobileNav>

      {/* p-4 no celular / p-8 no desktop: as telas de chat cancelam este
          padding com -m-4 md:-m-8 (conversas e e-mails). Mudou aqui, mude lá. */}
      <main className="min-w-0 flex-1 overflow-x-auto p-4 md:p-8">{children}</main>
    </div>
  );
}
