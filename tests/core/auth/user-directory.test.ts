import { describe, expect, it } from "vitest";

import {
  filterUsers,
  RECENTLY_ACTIVE_WINDOW_MS,
  summarizeUsers,
  type DirectoryUser,
} from "@/core/auth/user-directory";

const NOW = new Date("2026-09-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function user(overrides: Partial<DirectoryUser> & { email: string }): DirectoryUser {
  return {
    fullName: null,
    role: "staff",
    status: "ativo",
    lastSeenAt: null,
    ...overrides,
  };
}

const PEOPLE: DirectoryUser[] = [
  user({ email: "dona@trive.test", fullName: "Fabiana Dona", role: "owner", lastSeenAt: ago(60_000) }),
  user({ email: "joao@trive.test", fullName: "João Silva", lastSeenAt: ago(RECENTLY_ACTIVE_WINDOW_MS) }),
  user({ email: "ana@trive.test", fullName: "Ana Souza", status: "convite_pendente" }),
  user({ email: "maria@trive.test", fullName: "Maria Lima", status: "desativado", lastSeenAt: ago(1) }),
  user({ email: "socio@trive.test", fullName: "Sócio", role: "owner", status: "desativado" }),
  user({ email: "velho@trive.test", fullName: "Velho", lastSeenAt: ago(RECENTLY_ACTIVE_WINDOW_MS + 1) }),
];

describe("summarizeUsers", () => {
  it("conta ativos, convites pendentes e desativados pela situação", () => {
    const summary = summarizeUsers(PEOPLE, { now: NOW });
    expect(summary.total).toBe(6);
    expect(summary.active).toBe(3);
    expect(summary.pendingInvites).toBe(1);
    expect(summary.deactivated).toBe(2);
  });

  it("proprietários e funcionários contam só os ativos (nem convite pendente, nem desativado)", () => {
    const summary = summarizeUsers(PEOPLE, { now: NOW });
    expect(summary.owners).toBe(1);
    expect(summary.staff).toBe(2);
    expect(summary.owners + summary.staff).toBe(summary.active);
  });

  it("ativos nos últimos 7 dias: limite exato inclui, 1 ms além não, desativado nunca", () => {
    const summary = summarizeUsers(PEOPLE, { now: NOW });
    // dona (agora) + joao (exatamente 7 dias); velho (7 d + 1 ms) e maria (desativada) ficam de fora.
    expect(summary.activeLast7Days).toBe(2);
  });

  it("lista vazia devolve zeros", () => {
    expect(summarizeUsers([], { now: NOW })).toEqual({
      total: 0,
      active: 0,
      owners: 0,
      staff: 0,
      pendingInvites: 0,
      deactivated: 0,
      activeLast7Days: 0,
    });
  });
});

describe("filterUsers", () => {
  it("q casa nome ou e-mail, sem maiúsculas nem acentos", () => {
    expect(filterUsers(PEOPLE, { q: "joao" }).map((p) => p.email)).toEqual(["joao@trive.test"]);
    expect(filterUsers(PEOPLE, { q: "JOÃO" }).map((p) => p.email)).toEqual(["joao@trive.test"]);
    expect(filterUsers(PEOPLE, { q: "socio@" }).map((p) => p.email)).toEqual(["socio@trive.test"]);
    expect(filterUsers(PEOPLE, { q: "  souza " }).map((p) => p.email)).toEqual(["ana@trive.test"]);
    expect(filterUsers(PEOPLE, { q: "ninguém" })).toEqual([]);
  });

  it("combina papel e situação (E, não OU)", () => {
    expect(filterUsers(PEOPLE, { role: "owner", status: "desativado" }).map((p) => p.email)).toEqual([
      "socio@trive.test",
    ]);
    expect(filterUsers(PEOPLE, { role: "owner" })).toHaveLength(2);
    expect(filterUsers(PEOPLE, { status: "ativo", q: "trive" })).toHaveLength(3);
  });

  it("sem filtros devolve tudo na mesma ordem", () => {
    expect(filterUsers(PEOPLE, {})).toEqual(PEOPLE);
    expect(filterUsers(PEOPLE, { q: "" })).toEqual(PEOPLE);
  });
});
