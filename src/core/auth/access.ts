// Fonte única das áreas do painel e de quem entra em cada uma. Puro (zero
// I/O): o menu, o guard de servidor (services/auth) e o teste de varredura
// leem daqui — é isso que impede o menu de divergir da proteção real.

export const ADMIN_AREAS = [
  "dashboard",
  "pedidos",
  "clientes",
  "produtos",
  "estoque",
  "fornecedores",
  "precos",
  "frete",
  "financeiro",
  "configuracoes",
  "whatsapp",
  "conversas",
  "relatorios",
  "cupons",
  "ajuda",
  "fila",
  "usuarios",
] as const;

export type AdminArea = (typeof ADMIN_AREAS)[number];

export type AdminRole = "owner" | "staff";

/**
 * Áreas que só o proprietário vê. O critério é exposição de dinheiro do
 * negócio (custo, margem, faturamento), de credenciais/configuração ou de
 * dados de outras pessoas: fila mostra payloads de eventos com valores e
 * telefones; relatórios exportam faturamento; usuários dá acesso ao acesso.
 *
 * As demais áreas são compartilhadas com a equipe — o corte fino dentro
 * delas (coluna Custo, margem do pedido, taxa do Mercado Pago) é feito na
 * própria página, não aqui.
 */
export const OWNER_ONLY_AREAS = [
  "fornecedores",
  "precos",
  "frete",
  "financeiro",
  "configuracoes",
  "whatsapp",
  "relatorios",
  "cupons",
  "fila",
  "usuarios",
] as const satisfies readonly AdminArea[];

export type OwnerOnlyArea = (typeof OWNER_ONLY_AREAS)[number];

/** Rótulos em pt-BR: menu, avisos e mensagens de bloqueio usam os mesmos. */
export const AREA_LABELS: Record<AdminArea, string> = {
  dashboard: "Dashboard",
  pedidos: "Pedidos",
  clientes: "Clientes",
  produtos: "Produtos",
  estoque: "Estoque",
  fornecedores: "Fornecedores",
  precos: "Preços",
  frete: "Frete",
  financeiro: "Financeiro",
  configuracoes: "Configurações",
  whatsapp: "WhatsApp",
  conversas: "Conversas",
  relatorios: "Relatórios",
  cupons: "Cupons",
  ajuda: "Ajuda",
  fila: "Fila",
  usuarios: "Usuários",
};

const ADMIN_AREA_SET: ReadonlySet<string> = new Set(ADMIN_AREAS);
const OWNER_ONLY_SET: ReadonlySet<string> = new Set(OWNER_ONLY_AREAS);

/** Valida o `?de=` da URL antes de virar rótulo (nunca ecoar texto cru). */
export function isAdminArea(value: unknown): value is AdminArea {
  return typeof value === "string" && ADMIN_AREA_SET.has(value);
}

export function isOwnerOnlyArea(area: AdminArea): area is OwnerOnlyArea {
  return OWNER_ONLY_SET.has(area);
}

export function canAccess(role: AdminRole, area: AdminArea): boolean {
  if (role === "owner") return true;
  return !OWNER_ONLY_SET.has(area);
}
