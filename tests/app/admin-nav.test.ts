// O menu lateral do painel: todo item aponta para uma área conhecida, tem
// ícone, e o título da barra do celular segue a rota.
import { describe, expect, it } from "vitest";

import { NAV_GROUPS, resolveNavTitle } from "@/app/admin/(protected)/nav";
import { ADMIN_AREAS } from "@/core/auth/access";

describe("NAV_GROUPS", () => {
  it("todo item tem ícone, href sob /admin e área registrada no core", () => {
    for (const group of NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(typeof item.icon, `${item.label} sem ícone`).toBe("object");
        expect(item.href.startsWith("/admin")).toBe(true);
        expect(ADMIN_AREAS).toContain(item.area);
      }
    }
  });

  it("não repete href", () => {
    const hrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("resolveNavTitle", () => {
  it("marca o item pela rota e pelas subrotas", () => {
    expect(resolveNavTitle("/admin")).toBe("Dashboard");
    expect(resolveNavTitle("/admin/produtos")).toBe("Produtos");
    expect(resolveNavTitle("/admin/produtos/novo")).toBe("Produtos");
    expect(resolveNavTitle("/admin/usuarios/abc#dados")).toBe("Usuários");
  });

  it("item exato não vaza para as subrotas; o href mais longo vence", () => {
    expect(resolveNavTitle("/admin/whatsapp")).toBe("Vendedora & WhatsApp");
    expect(resolveNavTitle("/admin/whatsapp/provador")).toBe("Provador");
    expect(resolveNavTitle("/admin/whatsapp/conversas/123")).toBe("Conversas");
  });

  it("fora do menu cai em Painel", () => {
    expect(resolveNavTitle("/admin/nova-senha")).toBe("Painel");
    expect(resolveNavTitle("/admin/sem-acesso")).toBe("Painel");
  });
});
