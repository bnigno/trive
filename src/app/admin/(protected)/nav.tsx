"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { cx } from "@/components/ui/cx";
import { WaNavBadge } from "./wa-nav-badge";

type NavItem = { label: string; href: string; badge?: ComponentType };
type NavGroup = { title: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Vendas",
    items: [
      { label: "Dashboard", href: "/admin" },
      { label: "Pedidos", href: "/admin/pedidos" },
      { label: "Clientes", href: "/admin/clientes" },
    ],
  },
  {
    title: "Catálogo",
    items: [
      { label: "Produtos", href: "/admin/produtos" },
      { label: "Estoque", href: "/admin/estoque" },
      { label: "Fornecedores", href: "/admin/fornecedores" },
      { label: "Preços", href: "/admin/precos" },
      { label: "Frete", href: "/admin/frete" },
    ],
  },
  {
    title: "Gestão",
    items: [
      { label: "Financeiro", href: "/admin/financeiro" },
      { label: "Configurações", href: "/admin/configuracoes" },
      { label: "WhatsApp", href: "/admin/whatsapp", badge: WaNavBadge },
      { label: "Relatórios", href: "/admin/relatorios" },
      { label: "Cupons", href: "/admin/cupons" },
      { label: "Ajuda", href: "/admin/ajuda" },
      { label: "Fila", href: "/admin/fila" },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  // Dashboard só marca em /admin exato; os demais marcam também subrotas
  // (ex.: /admin/produtos/novo mantém "Produtos" ativo).
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto p-3 text-sm">
      {NAV_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {group.title}
          </p>
          {group.items.map((item) => {
            const active = isActive(pathname, item.href);
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
      ))}
    </nav>
  );
}
