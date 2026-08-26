import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IdentityError,
  getIdentityProvider,
  type IdentityProvider,
} from "@/adapters/identity";
import { FakeIdentityProvider } from "@/adapters/identity/fake";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let identity: FakeIdentityProvider;

beforeEach(() => {
  identity = new FakeIdentityProvider();
});

describe("FakeIdentityProvider (contrato IdentityProvider)", () => {
  it("implementa a interface completa do contrato", () => {
    const provider: IdentityProvider = new FakeIdentityProvider();
    expect(provider.findByEmail).toBeTypeOf("function");
    expect(provider.createUser).toBeTypeOf("function");
    expect(provider.generateAccessLink).toBeTypeOf("function");
    expect(provider.setPassword).toBeTypeOf("function");
    expect(provider.setBanned).toBeTypeOf("function");
    expect(provider.deleteUser).toBeTypeOf("function");
  });

  it("getIdentityProvider devolve o fake quando ADAPTER_MODE não é 'real'", () => {
    expect(process.env.ADAPTER_MODE).not.toBe("real");
    expect(getIdentityProvider()).toBeInstanceOf(FakeIdentityProvider);
  });
});

describe("FakeIdentityProvider.createUser", () => {
  it("cria com id uuid, e-mail normalizado e já confirmado (padrão)", async () => {
    const user = await identity.createUser({
      email: "  Maria@Loja.com.BR ",
      fullName: "Maria da Silva",
      password: "senha-provisoria-123",
    });

    expect(user.id).toMatch(UUID_PATTERN);
    expect(user.email).toBe("maria@loja.com.br");
    expect(user.fullName).toBe("Maria da Silva");
    expect(user.emailConfirmedAt).toBeInstanceOf(Date);
    expect(user.banned).toBe(false);
    expect(identity.users).toHaveLength(1);
    expect(identity.users[0].password).toBe("senha-provisoria-123");
  });

  it("nunca devolve a senha no IdentityUser", async () => {
    const user = await identity.createUser({
      email: "maria@loja.com.br",
      password: "senha-provisoria-123",
    });
    expect(Object.keys(user)).not.toContain("password");
  });

  it("emailConfirm: false deixa a conta pendente de confirmação", async () => {
    const user = await identity.createUser({
      email: "novo@loja.com.br",
      emailConfirm: false,
    });
    expect(user.emailConfirmedAt).toBeNull();
  });

  it("e-mail repetido (mesmo com outra caixa) falha com email_ja_existe", async () => {
    await identity.createUser({ email: "maria@loja.com.br" });

    await expect(
      identity.createUser({ email: "MARIA@loja.com.br" }),
    ).rejects.toMatchObject({
      name: "IdentityError",
      code: "email_ja_existe",
    });
    expect(identity.users).toHaveLength(1);
  });
});

describe("FakeIdentityProvider.findByEmail", () => {
  it("acha sem diferenciar maiúsculas e devolve null quando não existe", async () => {
    identity.seed({ email: "dono@loja.com.br", fullName: "Dono" });

    const found = await identity.findByEmail("  DONO@Loja.com.br ");
    expect(found?.fullName).toBe("Dono");
    await expect(identity.findByEmail("outro@loja.com.br")).resolves.toBeNull();
  });
});

describe("FakeIdentityProvider.generateAccessLink", () => {
  it("invite em e-mail novo CRIA a conta pendente e devolve token/link", async () => {
    const link = await identity.generateAccessLink({
      email: "Nova@loja.com.br",
      type: "invite",
      redirectTo: "https://trivemaison.com.br/admin/nova-senha",
    });

    expect(link.type).toBe("invite");
    expect(link.tokenHash).toBe("fake-token-1");
    expect(link.actionLink).toContain("fake-token-1");
    expect(link.actionLink).toContain(
      encodeURIComponent("https://trivemaison.com.br/admin/nova-senha"),
    );
    expect(link.user.email).toBe("nova@loja.com.br");
    expect(link.user.emailConfirmedAt).toBeNull();
    expect(identity.users).toHaveLength(1);
    expect(identity.links).toHaveLength(1);
    expect(identity.links[0].tokenHash).toBe("fake-token-1");
  });

  it("tokenHash é sequencial entre chamadas", async () => {
    const first = await identity.generateAccessLink({
      email: "a@loja.com.br",
      type: "invite",
    });
    const second = await identity.generateAccessLink({
      email: "b@loja.com.br",
      type: "invite",
    });
    expect([first.tokenHash, second.tokenHash]).toEqual([
      "fake-token-1",
      "fake-token-2",
    ]);
  });

  it("invite para conta JÁ confirmada falha com email_ja_existe (igual ao GoTrue)", async () => {
    identity.seed({ email: "dono@loja.com.br" });

    await expect(
      identity.generateAccessLink({ email: "dono@loja.com.br", type: "invite" }),
    ).rejects.toMatchObject({ code: "email_ja_existe" });
    expect(identity.links).toHaveLength(0);
  });

  it("invite para conta pendente reenvia o convite sem criar outra conta", async () => {
    const seeded = identity.seed({
      email: "pendente@loja.com.br",
      emailConfirmedAt: null,
    });

    const link = await identity.generateAccessLink({
      email: "pendente@loja.com.br",
      type: "invite",
    });

    expect(link.user.id).toBe(seeded.id);
    expect(identity.users).toHaveLength(1);
  });

  it("recovery exige conta existente", async () => {
    await expect(
      identity.generateAccessLink({
        email: "ninguem@loja.com.br",
        type: "recovery",
      }),
    ).rejects.toMatchObject({ code: "usuario_nao_encontrado" });

    const seeded = identity.seed({ email: "dono@loja.com.br" });
    const link = await identity.generateAccessLink({
      email: "dono@loja.com.br",
      type: "recovery",
    });
    expect(link.type).toBe("recovery");
    expect(link.user.id).toBe(seeded.id);
    expect(link.tokenHash).toBe("fake-token-1");
  });
});

describe("FakeIdentityProvider: senha, desativação e remoção", () => {
  it("setPassword grava a nova senha da conta", async () => {
    const user = identity.seed({ email: "maria@loja.com.br", password: "antiga" });

    await identity.setPassword(user.id, "nova-senha-456");

    expect(identity.users[0].password).toBe("nova-senha-456");
  });

  it("setBanned desativa e reativa a conta", async () => {
    const user = identity.seed({ email: "maria@loja.com.br" });

    await identity.setBanned(user.id, true);
    expect(identity.users[0].banned).toBe(true);

    await identity.setBanned(user.id, false);
    expect(identity.users[0].banned).toBe(false);
  });

  it("deleteUser remove a conta (compensação de criação)", async () => {
    const user = identity.seed({ email: "maria@loja.com.br" });

    await identity.deleteUser(user.id);

    expect(identity.users).toHaveLength(0);
  });

  it("id inexistente falha com usuario_nao_encontrado nas três operações", async () => {
    const ghost = "11111111-1111-4111-8111-111111111111";

    await expect(identity.setPassword(ghost, "x")).rejects.toMatchObject({
      code: "usuario_nao_encontrado",
    });
    await expect(identity.setBanned(ghost, true)).rejects.toMatchObject({
      code: "usuario_nao_encontrado",
    });
    await expect(identity.deleteUser(ghost)).rejects.toMatchObject({
      code: "usuario_nao_encontrado",
    });
  });
});

describe("FakeIdentityProvider: helpers de teste", () => {
  it("failNext falha SÓ a próxima chamada do método escolhido", async () => {
    identity.failNext("createUser", "indisponivel");

    await expect(
      identity.createUser({ email: "maria@loja.com.br" }),
    ).rejects.toBeInstanceOf(IdentityError);
    // A conta não chegou a ser criada e a chamada seguinte funciona.
    expect(identity.users).toHaveLength(0);
    await expect(
      identity.createUser({ email: "maria@loja.com.br" }),
    ).resolves.toMatchObject({ email: "maria@loja.com.br" });
  });

  it("failNext atinge apenas o método configurado", async () => {
    identity.seed({ email: "maria@loja.com.br" });
    identity.failNext("deleteUser", "indisponivel");

    await expect(
      identity.findByEmail("maria@loja.com.br"),
    ).resolves.not.toBeNull();
    await expect(identity.deleteUser(identity.users[0].id)).rejects.toMatchObject(
      { code: "indisponivel" },
    );
  });

  it("reset limpa contas, links, sequência de token e falhas programadas", async () => {
    identity.seed({ email: "maria@loja.com.br", emailConfirmedAt: null });
    await identity.generateAccessLink({
      email: "maria@loja.com.br",
      type: "invite",
    });
    identity.failNext("createUser", "indisponivel");

    identity.reset();

    expect(identity.users).toHaveLength(0);
    expect(identity.links).toHaveLength(0);
    await expect(
      identity.createUser({ email: "maria@loja.com.br" }),
    ).resolves.toBeDefined();
    const link = await identity.generateAccessLink({
      email: "outra@loja.com.br",
      type: "invite",
    });
    expect(link.tokenHash).toBe("fake-token-1");
  });

  it("em dev (logToConsole) mostra senha e link no terminal", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    identity.logToConsole = true;

    await identity.createUser({
      email: "maria@loja.com.br",
      emailConfirm: false,
      password: "senha-provisoria-123",
    });
    await identity.generateAccessLink({
      email: "maria@loja.com.br",
      type: "invite",
    });

    const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("senha-provisoria-123");
    expect(logged).toContain("fake-token-1");
    spy.mockRestore();
  });

  it("silencioso por padrão dentro da suíte de testes", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await identity.createUser({
      email: "maria@loja.com.br",
      password: "senha-provisoria-123",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
