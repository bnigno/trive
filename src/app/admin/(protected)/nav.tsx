"use client";

import {
  Bot,
  Boxes,
  CalendarClock,
  ChartColumn,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  type LucideIcon,
  Mail,
  MapPinned,
  MessageCircle,
  Ruler,
  Settings,
  Shirt,
  ShoppingBag,
  Sparkles,
  Tags,
  TicketPercent,
  Truck,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import type { AdminArea, AdminRole } from "@/core/auth/access";
import { canAccess } from "@/core/auth/access";
import { cx } from "@/components/ui/cx";
import { EmailNavBadge } from "./emails/email-nav-badge";
import { WaNavBadge } from "./wa-nav-badge";

export type NavItem = {
  label: string;
  href: string;
  area: AdminArea;
  icon: LucideIcon;
  // Marca o item só na URL exata. Necessário quando um item é prefixo de
  // outro (/admin/whatsapp e /admin/whatsapp/conversas).
  exact?: boolean;
  badge?: ComponentType;
};
export type NavGroup = { title: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Vendas",
    items: [
      { label: "Dashboard", href: "/admin", area: "dashboard", icon: LayoutDashboard, exact: true },
      { label: "Pedidos", href: "/admin/pedidos", area: "pedidos", icon: ShoppingBag },
      { label: "Clientes", href: "/admin/clientes", area: "clientes", icon: Users },
    ],
  },
  {
    title: "Catálogo",
    items: [
      { label: "Produtos", href: "/admin/produtos", area: "produtos", icon: Shirt },
      { label: "Estoque", href: "/admin/estoque", area: "estoque", icon: Boxes },
      { label: "Fornecedores", href: "/admin/fornecedores", area: "fornecedores", icon: Truck },
      { label: "Preços", href: "/admin/precos", area: "precos", icon: Tags },
      { label: "Frete", href: "/admin/frete", area: "frete", icon: MapPinned },
      { label: "Lançamentos", href: "/admin/lancamentos", area: "lancamentos", icon: CalendarClock },
      { label: "Edições de Belém", href: "/admin/edicoes", area: "edicoes", icon: Sparkles },
    ],
  },
  {
    title: "Atendimento",
    items: [
      // O crachá de mensagem nova vive em Conversas: é o item que a equipe
      // enxerga. Se ficasse na Central do WhatsApp — área só do dono — o
      // funcionário deixaria de ver que a vendedora passou uma conversa para
      // humano. (Os toasts e o bipe são do avisador, no layout.)
      {
        label: "Conversas",
        href: "/admin/whatsapp/conversas",
        area: "conversas",
        icon: MessageCircle,
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
        icon: Mail,
        badge: EmailNavBadge,
      },
      {
        label: "Vendedora & WhatsApp",
        href: "/admin/whatsapp",
        area: "whatsapp",
        icon: Bot,
        exact: true,
      },
      { label: "Provador", href: "/admin/whatsapp/provador", area: "whatsapp", icon: Ruler },
    ],
  },
  {
    title: "Gestão",
    items: [
      { label: "Financeiro", href: "/admin/financeiro", area: "financeiro", icon: Wallet },
      { label: "Configurações", href: "/admin/configuracoes", area: "configuracoes", icon: Settings },
      { label: "Usuários", href: "/admin/usuarios", area: "usuarios", icon: UserCog },
      { label: "Relatórios", href: "/admin/relatorios", area: "relatorios", icon: ChartColumn },
      { label: "Cupons", href: "/admin/cupons", area: "cupons", icon: TicketPercent },
      { label: "Ajuda", href: "/admin/ajuda", area: "ajuda", icon: LifeBuoy },
      { label: "Fila", href: "/admin/fila", area: "fila", icon: ListChecks },
    ],
  },
];

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  // Sem `exact`, o item também marca nas subrotas (ex.: /admin/produtos/novo
  // mantém "Produtos" ativo).
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Nome da área atual para a barra do celular; "Painel" fora do menu. */
export function resolveNavTitle(pathname: string): string {
  // O href mais longo vence quando dois itens casam (/admin/whatsapp/provador
  // sobre /admin/whatsapp), independente da ordem no menu.
  let best: NavItem | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (!isNavItemActive(pathname, item)) continue;
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best?.label ?? "Painel";
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
          <div key={group.title} className="flex flex-col gap-0.5">
            <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
              {group.title}
            </p>
            {items.map((item) => {
              const active = isNavItemActive(pathname, item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/60",
                    active
                      ? "bg-white/10 text-white before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-gold-400"
                      : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    strokeWidth={1.75}
                    className={cx(
                      "size-[18px] shrink-0 transition-colors",
                      active ? "text-gold-400" : "text-zinc-500 group-hover:text-zinc-300",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
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
