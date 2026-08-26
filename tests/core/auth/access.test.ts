import { describe, expect, it } from "vitest";
import {
  ADMIN_AREAS,
  AREA_LABELS,
  OWNER_ONLY_AREAS,
  canAccess,
  isAdminArea,
  isOwnerOnlyArea,
  type AdminArea,
} from "@/core/auth/access";

// Áreas que a equipe enxerga. Escrita à mão de propósito: se alguém mover
// uma área de lado, este teste obriga a decisão a ser consciente.
const SHARED_AREAS: AdminArea[] = [
  "dashboard",
  "pedidos",
  "clientes",
  "produtos",
  "estoque",
  "conversas",
  "emails",
  "ajuda",
];

describe("core/auth/access", () => {
  it("lista as 18 áreas do painel sem repetição", () => {
    expect(new Set(ADMIN_AREAS).size).toBe(ADMIN_AREAS.length);
    expect(ADMIN_AREAS).toHaveLength(18);
  });

  it("owner-only é exatamente o mapa aprovado", () => {
    expect([...OWNER_ONLY_AREAS]).toEqual([
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
    ]);
  });

  it("owner-only e compartilhadas juntas cobrem todas as áreas", () => {
    const union = new Set<string>([...OWNER_ONLY_AREAS, ...SHARED_AREAS]);
    expect(union.size).toBe(ADMIN_AREAS.length);
    for (const area of ADMIN_AREAS) {
      expect(union.has(area)).toBe(true);
    }
    // Nenhuma área nos dois lados.
    for (const area of SHARED_AREAS) {
      expect(OWNER_ONLY_AREAS as readonly string[]).not.toContain(area);
    }
  });

  it("toda área tem rótulo pt-BR não vazio", () => {
    expect(Object.keys(AREA_LABELS).sort()).toEqual([...ADMIN_AREAS].sort());
    for (const area of ADMIN_AREAS) {
      expect(AREA_LABELS[area].trim().length).toBeGreaterThan(0);
    }
    expect(AREA_LABELS.financeiro).toBe("Financeiro");
    expect(AREA_LABELS.precos).toBe("Preços");
    expect(AREA_LABELS.fornecedores).toBe("Fornecedores");
    expect(AREA_LABELS.configuracoes).toBe("Configurações");
    expect(AREA_LABELS.relatorios).toBe("Relatórios");
    expect(AREA_LABELS.usuarios).toBe("Usuários");
    expect(AREA_LABELS.conversas).toBe("Conversas");
    expect(AREA_LABELS.emails).toBe("E-mails");
  });

  it("proprietário entra em todas as áreas", () => {
    for (const area of ADMIN_AREAS) {
      expect(canAccess("owner", area)).toBe(true);
    }
  });

  it("equipe entra nas compartilhadas e só nelas", () => {
    for (const area of ADMIN_AREAS) {
      const expected = !(OWNER_ONLY_AREAS as readonly string[]).includes(area);
      expect(canAccess("staff", area)).toBe(expected);
    }
    for (const area of SHARED_AREAS) {
      expect(canAccess("staff", area)).toBe(true);
    }
  });

  it("equipe é barrada nas áreas de dinheiro e de acesso", () => {
    expect(canAccess("staff", "financeiro")).toBe(false);
    expect(canAccess("staff", "precos")).toBe(false);
    expect(canAccess("staff", "fornecedores")).toBe(false);
    expect(canAccess("staff", "relatorios")).toBe(false);
    expect(canAccess("staff", "configuracoes")).toBe(false);
    expect(canAccess("staff", "usuarios")).toBe(false);
    expect(canAccess("staff", "fila")).toBe(false);
  });

  it("WhatsApp é do dono, mas Conversas é compartilhada", () => {
    expect(canAccess("staff", "whatsapp")).toBe(false);
    expect(canAccess("staff", "conversas")).toBe(true);
  });

  it("a caixa de e-mail é compartilhada com a equipe", () => {
    // Mesmo motivo de Conversas: é canal de atendimento. Fechar no dono
    // deixaria cliente esperando sempre que ele não estivesse na loja.
    expect(canAccess("staff", "emails")).toBe(true);
  });

  it("isOwnerOnlyArea concorda com canAccess", () => {
    for (const area of ADMIN_AREAS) {
      expect(isOwnerOnlyArea(area)).toBe(!canAccess("staff", area));
    }
  });

  it("isAdminArea aceita as áreas conhecidas", () => {
    for (const area of ADMIN_AREAS) {
      expect(isAdminArea(area)).toBe(true);
    }
  });

  it("isAdminArea rejeita lixo vindo da URL", () => {
    const junk: unknown[] = [
      "",
      " ",
      "financeiro ",
      "Financeiro",
      "FINANCEIRO",
      "financeiro,precos",
      "<script>alert(1)</script>",
      "__proto__",
      "constructor",
      "toString",
      "usuarios/novo",
      null,
      undefined,
      0,
      1,
      true,
      {},
      [],
      ["financeiro"],
    ];
    for (const value of junk) {
      expect(isAdminArea(value)).toBe(false);
    }
  });
});
