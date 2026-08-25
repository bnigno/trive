import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/services/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-5 dark:border-zinc-800">
          <Link
            href="/admin"
            className="text-lg font-semibold tracking-[0.2em] text-zinc-900 dark:text-zinc-100"
          >
            TRIVË
          </Link>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Painel administrativo
          </p>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3 text-sm">
          <Link
            href="/admin"
            className="rounded-md px-3 py-2 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Dashboard
          </Link>
          <Link
            href="/admin/fila"
            className="rounded-md px-3 py-2 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Fila
          </Link>
          <span
            aria-disabled="true"
            className="cursor-not-allowed rounded-md px-3 py-2 text-zinc-400 dark:text-zinc-600"
          >
            Configurações
            <span className="ml-2 text-xs">(em breve)</span>
          </span>
        </nav>

        <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
          <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {user.fullName ?? user.email}
          </p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {user.role === "owner" ? "Proprietário" : "Equipe"}
          </p>
          <form action={signOut} className="mt-3">
            <button
              type="submit"
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Sair
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  );
}
