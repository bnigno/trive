"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import type { AdminArea, AdminRole } from "@/core/auth/access";
import { canAccess } from "@/core/auth/access";
import { cx } from "@/components/ui/cx";
import { EmailNavBadge } from "./emails/email-nav-badge";
import { WaNavBadge } from "./wa-nav-badge";

type NavItem = {
  label: string;
  href: string;
  area: AdminArea;
  // Marca o item só na URL exata. Necessário quando um item é prefixo de
  // outro (/admin/whatsapp e /admin/whatsapp/conversas).
  exact?: boolean;
  badge?: ComponentType;
};
type NavGroup = { title: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Vendas",
    items: [
      { label: "Dashboard", href: "/admin", area: "dashboard", exact: true },
      { label: "Pedidos", href: "/admin/pedidos", area: "pedidos" },
      { label: "Clientes", href: "/admin/clientes", area: "clientes" },
    ],
  },
  {
    title: "Catálogo",
    items: [
      { label: "Produtos", href: "/admin/produtos", area: "produtos" },
      { label: "Estoque", href: "/admin/estoque", area: "estoque" },
      {
        label: "Fornecedores",
        href: "/admin/fornecedores",
        area: "fornecedores",
      },
      { label: "Preços", href: "/admin/precos", area: "precos" },
      { label: "Frete", href: "/admin/frete", area: "frete" },
    ],
  },
  {
    title: "Atendimento",
    items: [
      // O badge (e o viewport de avisos de transferência que ele monta) vive
      // em Conversas: é o item que a equipe enxerga. Se ficasse na Central do
      // WhatsApp — área só do dono — o funcionário deixaria de receber o
      // aviso de que a vendedora passou uma conversa para humano.
      {
        label: "Conversas",
        href: "/admin/whatsapp/conversas",
        area: "conversas",
        badge: WaNavBadge,
      },
      // Mesma razão da Conversas: a caixa de e-mail é atendimento, então a
      // equipe entra. O crachá conta as conversas com mensagem que ninguém
      // abriu ainda — é o "tem gente esperando" do canal de e-mail, já que
      // aqui não existe robô para transferir nada.
      {
        label: "E-mails",
        href: "/admin/emails",
        area: "emails",
        badge: EmailNavBadge,
      },
      {
        label: "Vendedora & WhatsApp",
        href: "/admin/whatsapp",
        area: "whatsapp",
        exact: true,
      },
    ],
  },
  {
    title: "Gestão",
    items: [
      { label: "Financeiro", href: "/admin/financeiro", area: "financeiro" },
      {
        label: "Configurações",
        href: "/admin/configuracoes",
        area: "configuracoes",
      },
      { label: "Usuários", href: "/admin/usuarios", area: "usuarios" },
      { label: "Relatórios", href: "/admin/relatorios", area: "relatorios" },
      { label: "Cupons", href: "/admin/cupons", area: "cupons" },
      { label: "Ajuda", href: "/admin/ajuda", area: "ajuda" },
      { label: "Fila", href: "/admin/fila", area: "fila" },
    ],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  // Sem `exact`, o item também marca nas subrotas (ex.: /admin/produtos/novo
  // mantém "Produtos" ativo).
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AdminNav({ role }: { role: AdminRole }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto p-3 text-sm">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => canAccess(role, item.area));
        // Grupo inteiro fora do alcance do papel não vira título solto.
        if (items.length === 0) return null;

        return (
          <div key={group.title} className="flex flex-col gap-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {group.title}
            </p>
            {items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex items-center gap-2 rounded-md px-3 py-2 font-medium transition-colors",
                    active
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                      : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
                  )}
                >
                  {item.label}
                  {item.badge ? <item.badge /> : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
