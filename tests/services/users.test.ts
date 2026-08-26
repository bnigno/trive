// Matriz do serviço de usuários do painel: criação (incluindo adoção de conta
// órfã e compensação da escrita dupla), regras de segurança de papel/estado,
// redefinição de senha pelo dono, recuperação self-service (anti-enumeração e
// limite) e leitura. Banco real (PGlite) + provedores fake.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmailProvider } from "@/adapters/email/fake";
import { FakeIdentityProvider } from "@/adapters/identity/fake";
import * as schema from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import {
  ServiceError,
  createUser,
  getUserDetail,
  listUsers,
  recordPasswordChanged,
  requestPasswordReset,
  resetUserPassword,
  setUserActive,
  updateUser,
  type UsersDeps,
} from "@/services/users";
import {
  createTestDb,
  createTestUser,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let identity: FakeIdentityProvider;
let email: FakeEmailProvider;
let deps: UsersDeps;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  identity = new FakeIdentityProvider();
  email = new FakeEmailProvider();
  deps = { identity, email };
});

afterEach(async () => {
  await close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Falha a asserção quando NÃO houve ServiceError; devolve o erro tipado. */
async function expectServiceError(
  promise: Promise<unknown>,
  code: string,
): Promise<ServiceError> {
  const error = await promise.then(
    () => {
      throw new Error(`esperava ServiceError '${code}', mas a chamada passou`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

async function auditsFor(userId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.entityType, "user"),
        eq(schema.auditLog.entityId, userId),
      ),
    )
    .orderBy(schema.auditLog.id);
}

async function userRow(userId: string) {
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row;
}

/** Simula o banco caindo depois que a conta de acesso já foi criada. */
function dbWithFailingTransaction(base: TestDb): TestDb {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "transaction") {
        return () => Promise.reject(new Error("falha simulada na transação"));
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const invite = {
  actorId: FIXED_USER_ID,
  email: "ana@loja.com",
  fullName: "Ana Souza",
  role: "staff",
  mode: "invite",
} as const;

const withPassword = { ...invite, mode: "password" } as const;

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

describe("createUser — senha provisória", () => {
  it("cria a conta de acesso e a linha com o MESMO id", async () => {
    const result = await createUser(db, deps, withPassword);

    expect(result.mode).toBe("password");
    expect(result.temporaryPassword).toMatch(/^Trv-/);
    expect(result.accessUrl).toBeNull();
    expect(result.adopted).toBe(false);
    expect(identity.users).toHaveLength(1);
    expect(identity.users[0].id).toBe(result.user.id);
    expect(identity.users[0].password).toBe(result.temporaryPassword);
    // Sem e-mail confirmado a pessoa não conseguiria entrar com a senha.
    expect(identity.users[0].emailConfirmedAt).toBeInstanceOf(Date);

    const row = await userRow(result.user.id);
    expect(row.email).toBe("ana@loja.com");
    expect(row.fullName).toBe("Ana Souza");
    expect(row.role).toBe("staff");
    expect(row.isActive).toBe(true);
  });

  it("nunca grava a senha provisória no audit", async () => {
    const result = await createUser(db, deps, withPassword);
    const audits = await auditsFor(result.user.id);

    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("user.create");
    expect(audits[0].actorId).toBe(FIXED_USER_ID);
    expect(JSON.stringify(audits)).not.toContain(String(result.temporaryPassword));
  });

  it("normaliza o e-mail (espaços e maiúsculas) dos dois lados", async () => {
    const result = await createUser(db, deps, {
      ...withPassword,
      email: "  Ana@Loja.COM ",
    });

    expect(result.user.email).toBe("ana@loja.com");
    expect(identity.users[0].email).toBe("ana@loja.com");
  });

  it("cria proprietário quando o papel pedido é owner", async () => {
    const result = await createUser(db, deps, {
      ...withPassword,
      role: "owner",
    });
    expect(result.user.role).toBe("owner");
  });

  it("não manda a senha por e-mail nem quando pedem", async () => {
    const result = await createUser(db, deps, {
      ...withPassword,
      sendEmail: true,
    });

    expect(result.emailSent).toBe(false);
    expect(email.sentEmails).toHaveLength(0);
  });
});

describe("createUser — convite", () => {
  it("devolve o link no formato /admin/acesso?token_hash=...&type=invite", async () => {
    const result = await createUser(db, deps, invite);

    expect(result.temporaryPassword).toBeNull();
    expect(result.accessUrl).toBe(
      `${siteUrl()}/admin/acesso?token_hash=fake-token-1&type=invite`,
    );
    expect(identity.links).toHaveLength(1);
    expect(identity.links[0].type).toBe("invite");
    expect(result.user.id).toBe(identity.users[0].id);
  });

  it("nunca grava o token do link no audit", async () => {
    const result = await createUser(db, deps, invite);
    const audits = await auditsFor(result.user.id);
    expect(JSON.stringify(audits)).not.toContain("fake-token-1");
  });

  it("envia o convite quando pedido e marca emailSent", async () => {
    const result = await createUser(db, deps, { ...invite, sendEmail: true });

    expect(result.emailSent).toBe(true);
    expect(email.sentEmails).toHaveLength(1);
    expect(email.sentEmails[0].to).toBe("ana@loja.com");
    expect(email.sentEmails[0].text).toContain(String(result.accessUrl));
  });

  it("sem canal de e-mail configurado, cria assim mesmo (link na tela)", async () => {
    const result = await createUser(
      db,
      { identity, email: null },
      { ...invite, sendEmail: true },
    );

    expect(result.emailSent).toBe(false);
    expect(result.accessUrl).not.toBeNull();
    expect(await userRow(result.user.id)).toBeDefined();
  });

  it("falha de envio não derruba a criação", async () => {
    const brokenEmail = {
      send: async () => {
        throw new Error("provedor fora do ar");
      },
    };

    const result = await createUser(
      db,
      { identity, email: brokenEmail },
      { ...invite, sendEmail: true },
    );

    expect(result.emailSent).toBe(false);
    expect(await userRow(result.user.id)).toBeDefined();
  });
});

describe("createUser — adoção de conta órfã", () => {
  it("reaproveita conta confirmada do provedor (script legado)", async () => {
    const orphan = identity.seed({ email: "ana@loja.com" });

    const result = await createUser(db, deps, withPassword);

    expect(result.adopted).toBe(true);
    expect(result.user.id).toBe(orphan.id);
    expect(identity.users).toHaveLength(1);
    expect(identity.users[0].password).toBe(result.temporaryPassword);
  });

  it("conta confirmada + convite usa type=recovery (o GoTrue recusa invite)", async () => {
    const orphan = identity.seed({ email: "ana@loja.com" });

    const result = await createUser(db, deps, invite);

    expect(result.adopted).toBe(true);
    expect(result.user.id).toBe(orphan.id);
    expect(identity.links[0].type).toBe("recovery");
    expect(result.accessUrl).toContain("type=recovery");
  });

  it("conta ainda não confirmada + convite reenvia como invite", async () => {
    const orphan = identity.seed({
      email: "ana@loja.com",
      emailConfirmedAt: null,
    });

    const result = await createUser(db, deps, invite);

    expect(result.user.id).toBe(orphan.id);
    expect(identity.links[0].type).toBe("invite");
    expect(identity.users).toHaveLength(1);
  });

  it("desbane a conta órfã antes de entregar o acesso", async () => {
    identity.seed({ email: "ana@loja.com", banned: true });

    await createUser(db, deps, withPassword);

    expect(identity.users[0].banned).toBe(false);
  });
});

describe("createUser — falhas", () => {
  it("recusa e-mail já cadastrado, ignorando maiúsculas, sem tocar no provedor", async () => {
    await createTestUser(db, { email: "ana@loja.com" });

    const error = await expectServiceError(
      createUser(db, deps, { ...withPassword, email: "ANA@Loja.com" }),
      "email_duplicado",
    );
    expect(error.message).toContain("Já existe um usuário");
    expect(identity.users).toHaveLength(0);
  });

  it("recusa ator que não é proprietário", async () => {
    const staff = await createTestUser(db, { role: "staff" });

    await expectServiceError(
      createUser(db, deps, { ...withPassword, actorId: staff.id }),
      "nao_autorizado",
    );
    expect(identity.users).toHaveLength(0);
  });

  it("recusa proprietário desativado (papel vem do banco, não do chamador)", async () => {
    const inactiveOwner = await createTestUser(db, {
      role: "owner",
      isActive: false,
    });

    await expectServiceError(
      createUser(db, deps, { ...withPassword, actorId: inactiveOwner.id }),
      "nao_autorizado",
    );
  });

  it("recusa ator inexistente", async () => {
    await expectServiceError(
      createUser(db, deps, {
        ...withPassword,
        actorId: "00000000-0000-4000-8000-0000000000ff",
      }),
      "nao_autorizado",
    );
  });

  it("traduz indisponibilidade do provedor e não grava nada", async () => {
    identity.failNext("createUser", "indisponivel");

    await expectServiceError(
      createUser(db, deps, withPassword),
      "identidade_indisponivel",
    );
    expect(await listUsers(db)).toHaveLength(1);
  });

  it("desfaz a conta criada quando a gravação falha", async () => {
    const failing = dbWithFailingTransaction(db);

    await expect(createUser(failing, deps, withPassword)).rejects.toThrow(
      "falha simulada",
    );
    expect(identity.users).toHaveLength(0);
  });

  it("erro acesso_orfao com instrução verdadeira quando a limpeza também falha", async () => {
    const failing = dbWithFailingTransaction(db);
    identity.failNext("deleteUser", "indisponivel");

    const error = await expectServiceError(
      createUser(failing, deps, withPassword),
      "acesso_orfao",
    );
    expect(error.message).toContain("Cadastre a pessoa de novo");
    expect(identity.users).toHaveLength(1);
  });

  it("NÃO apaga conta adotada quando a gravação falha", async () => {
    identity.seed({ email: "ana@loja.com" });
    const failing = dbWithFailingTransaction(db);

    await expect(createUser(failing, deps, withPassword)).rejects.toThrow(
      "falha simulada",
    );
    expect(identity.users).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edição e estado
// ---------------------------------------------------------------------------

describe("updateUser", () => {
  it("altera nome e papel e registra before/after", async () => {
    const person = await createTestUser(db, { fullName: "Ana" });

    const updated = await updateUser(db, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      fullName: "Ana Souza",
      role: "owner",
    });

    expect(updated.fullName).toBe("Ana Souza");
    expect(updated.role).toBe("owner");

    const audits = await auditsFor(person.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("user.update");
    expect(audits[0].before).toEqual({ fullName: "Ana", role: "staff" });
    expect(audits[0].after).toEqual({ fullName: "Ana Souza", role: "owner" });
  });

  it("não grava audit quando nada muda", async () => {
    const person = await createTestUser(db, { fullName: "Ana" });

    await updateUser(db, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      fullName: "Ana",
      role: "staff",
    });

    expect(await auditsFor(person.id)).toHaveLength(0);
  });

  it("bloqueia auto-rebaixamento quando existe outro proprietário", async () => {
    await createTestUser(db, { role: "owner" });

    await expectServiceError(
      updateUser(db, {
        actorId: FIXED_USER_ID,
        userId: FIXED_USER_ID,
        role: "staff",
      }),
      "auto_rebaixamento",
    );
    expect((await userRow(FIXED_USER_ID)).role).toBe("owner");
  });

  it("bloqueia rebaixar o ÚLTIMO proprietário ativo", async () => {
    await createTestUser(db, { role: "owner", isActive: false });

    const error = await expectServiceError(
      updateUser(db, {
        actorId: FIXED_USER_ID,
        userId: FIXED_USER_ID,
        role: "staff",
      }),
      "ultimo_owner",
    );
    expect(error.message).toContain("Torne outra pessoa proprietária");
  });

  it("permite rebaixar outro proprietário quando ainda sobra um ativo", async () => {
    const other = await createTestUser(db, { role: "owner" });

    const updated = await updateUser(db, {
      actorId: FIXED_USER_ID,
      userId: other.id,
      role: "staff",
    });
    expect(updated.role).toBe("staff");
  });

  it("recusa ator que não é proprietário", async () => {
    const staff = await createTestUser(db, { role: "staff" });

    await expectServiceError(
      updateUser(db, {
        actorId: staff.id,
        userId: staff.id,
        fullName: "Novo Nome",
      }),
      "nao_autorizado",
    );
  });

  it("recusa usuário inexistente", async () => {
    await expectServiceError(
      updateUser(db, {
        actorId: FIXED_USER_ID,
        userId: "00000000-0000-4000-8000-0000000000ff",
        fullName: "Fantasma",
      }),
      "nao_encontrado",
    );
  });
});

describe("setUserActive", () => {
  it("desativa: bane no provedor, marca inativo e registra o motivo", async () => {
    const person = await createTestUser(db, { email: "ana@loja.com" });
    identity.seed({ id: person.id, email: "ana@loja.com" });

    const updated = await setUserActive(db, deps, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      isActive: false,
      reason: "saiu da equipe",
    });

    expect(updated.isActive).toBe(false);
    expect(identity.users[0].banned).toBe(true);

    const audits = await auditsFor(person.id);
    expect(audits[0].action).toBe("user.deactivate");
    expect(audits[0].reason).toBe("saiu da equipe");
  });

  it("ativa: desbane no provedor e volta a valer", async () => {
    const person = await createTestUser(db, {
      email: "ana@loja.com",
      isActive: false,
    });
    identity.seed({ id: person.id, email: "ana@loja.com", banned: true });

    const updated = await setUserActive(db, deps, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      isActive: true,
    });

    expect(updated.isActive).toBe(true);
    expect(identity.users[0].banned).toBe(false);
    expect((await auditsFor(person.id))[0].action).toBe("user.activate");
  });

  it("desativa mesmo sem conta no provedor (o bloqueio não pode travar)", async () => {
    const person = await createTestUser(db);

    const updated = await setUserActive(db, deps, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      isActive: false,
    });
    expect(updated.isActive).toBe(false);
  });

  it("ativar sem conta no provedor avisa em vez de fingir que deu certo", async () => {
    const person = await createTestUser(db, { isActive: false });

    await expectServiceError(
      setUserActive(db, deps, {
        actorId: FIXED_USER_ID,
        userId: person.id,
        isActive: true,
      }),
      "acesso_nao_encontrado",
    );
    expect((await userRow(person.id)).isActive).toBe(false);
  });

  it("bloqueia auto-desativação quando existe outro proprietário", async () => {
    await createTestUser(db, { role: "owner" });

    await expectServiceError(
      setUserActive(db, deps, {
        actorId: FIXED_USER_ID,
        userId: FIXED_USER_ID,
        isActive: false,
      }),
      "auto_desativacao",
    );
    expect((await userRow(FIXED_USER_ID)).isActive).toBe(true);
  });

  it("bloqueia desativar o ÚLTIMO proprietário ativo", async () => {
    await expectServiceError(
      setUserActive(db, deps, {
        actorId: FIXED_USER_ID,
        userId: FIXED_USER_ID,
        isActive: false,
      }),
      "ultimo_owner",
    );
  });

  it("é no-op silencioso quando o estado já é o pedido", async () => {
    const person = await createTestUser(db);

    await setUserActive(db, deps, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      isActive: true,
    });
    expect(await auditsFor(person.id)).toHaveLength(0);
  });

  it("recusa ator que não é proprietário", async () => {
    const staff = await createTestUser(db, { role: "staff" });
    const person = await createTestUser(db);

    await expectServiceError(
      setUserActive(db, deps, {
        actorId: staff.id,
        userId: person.id,
        isActive: false,
      }),
      "nao_autorizado",
    );
  });
});

// ---------------------------------------------------------------------------
// Redefinição pelo dono
// ---------------------------------------------------------------------------

describe("resetUserPassword", () => {
  it("senha provisória: troca no provedor e não guarda no audit", async () => {
    const person = await createTestUser(db, { email: "ana@loja.com" });
    identity.seed({ id: person.id, email: "ana@loja.com" });

    const result = await resetUserPassword(db, deps, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      mode: "password",
    });

    expect(result.temporaryPassword).toMatch(/^Trv-/);
    expect(identity.users[0].password).toBe(result.temporaryPassword);

    const audits = await auditsFor(person.id);
    expect(audits[0].action).toBe("user.password_reset");
    expect(audits[0].after).toEqual({ mode: "password" });
    expect(JSON.stringify(audits)).not.toContain(String(result.temporaryPassword));
  });

  it("link: devolve /admin/acesso com type=recovery e envia quando pedido", async () => {
    const person = await createTestUser(db, { email: "ana@loja.com" });
    identity.seed({ id: person.id, email: "ana@loja.com" });

    const result = await resetUserPassword(db, deps, {
      actorId: FIXED_USER_ID,
      userId: person.id,
      mode: "link",
      sendEmail: true,
    });

    expect(result.accessUrl).toBe(
      `${siteUrl()}/admin/acesso?token_hash=fake-token-1&type=recovery`,
    );
    expect(result.temporaryPassword).toBeNull();
    expect(result.emailSent).toBe(true);
    expect(email.sentEmails[0].to).toBe("ana@loja.com");
    expect(email.sentEmails[0].subject).toContain("Redefinir");
  });

  it("bloqueia redefinição de acesso desativado", async () => {
    const person = await createTestUser(db, { isActive: false });

    const error = await expectServiceError(
      resetUserPassword(db, deps, {
        actorId: FIXED_USER_ID,
        userId: person.id,
        mode: "password",
      }),
      "usuario_inativo",
    );
    expect(error.message).toContain("Ative o acesso");
  });

  it("recusa ator que não é proprietário", async () => {
    const staff = await createTestUser(db, { role: "staff" });

    await expectServiceError(
      resetUserPassword(db, deps, {
        actorId: staff.id,
        userId: staff.id,
        mode: "password",
      }),
      "nao_autorizado",
    );
  });

  it("traduz conta ausente no provedor", async () => {
    const person = await createTestUser(db);

    await expectServiceError(
      resetUserPassword(db, deps, {
        actorId: FIXED_USER_ID,
        userId: person.id,
        mode: "password",
      }),
      "acesso_nao_encontrado",
    );
    expect(await auditsFor(person.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Self-service (página pública)
// ---------------------------------------------------------------------------

describe("requestPasswordReset", () => {
  async function seedPerson(email = "ana@loja.com") {
    const person = await createTestUser(db, { email });
    identity.seed({ id: person.id, email });
    return person;
  }

  it("envia o link e registra o pedido", async () => {
    const person = await seedPerson();

    const result = await requestPasswordReset(db, deps, {
      email: "Ana@Loja.com",
    });

    expect(result.status).toBe("enviado");
    expect(email.sentEmails).toHaveLength(1);
    expect(email.sentEmails[0].text).toContain("type=recovery");

    const audits = await auditsFor(person.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("user.password_reset_requested");
    expect(JSON.stringify(audits)).not.toContain("fake-token-1");
  });

  it("e-mail desconhecido: mesma resposta, sem e-mail e sem audit", async () => {
    const result = await requestPasswordReset(db, deps, {
      email: "ninguem@loja.com",
    });

    expect(result.status).toBe("enviado");
    expect(email.sentEmails).toHaveLength(0);
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it("acesso desativado: mesma resposta, sem efeito", async () => {
    const person = await createTestUser(db, {
      email: "ana@loja.com",
      isActive: false,
    });
    identity.seed({ id: person.id, email: "ana@loja.com" });

    const result = await requestPasswordReset(db, deps, {
      email: "ana@loja.com",
    });

    expect(result.status).toBe("enviado");
    expect(email.sentEmails).toHaveLength(0);
    expect(await auditsFor(person.id)).toHaveLength(0);
  });

  it("linha sem conta no provedor não vaza o erro", async () => {
    const person = await createTestUser(db, { email: "ana@loja.com" });

    const result = await requestPasswordReset(db, deps, {
      email: "ana@loja.com",
    });

    expect(result.status).toBe("enviado");
    expect(email.sentEmails).toHaveLength(0);
    expect(await auditsFor(person.id)).toHaveLength(0);
  });

  it("limita a 3 pedidos por hora", async () => {
    const person = await seedPerson();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await requestPasswordReset(db, deps, {
        email: "ana@loja.com",
      });
      expect(result.status).toBe("enviado");
    }

    expect(email.sentEmails).toHaveLength(3);
    expect(await auditsFor(person.id)).toHaveLength(3);
  });

  it("sem canal de e-mail: diz que não está configurado (nunca skip silencioso)", async () => {
    const person = await seedPerson();

    const result = await requestPasswordReset(
      db,
      { identity, email: null },
      { email: "ana@loja.com" },
    );

    expect(result.status).toBe("email_nao_configurado");
    expect(await auditsFor(person.id)).toHaveLength(0);
  });

  it("falha de envio não vira erro visível (denunciaria o e-mail)", async () => {
    const person = await seedPerson();
    const brokenEmail = {
      send: async () => {
        throw new Error("provedor fora do ar");
      },
    };

    const result = await requestPasswordReset(
      db,
      { identity, email: brokenEmail },
      { email: "ana@loja.com" },
    );

    expect(result.status).toBe("enviado");
    // O pedido conta para o limite mesmo assim.
    expect(await auditsFor(person.id)).toHaveLength(1);
  });
});

describe("recordPasswordChanged", () => {
  it("registra a troca feita pela própria pessoa", async () => {
    const person = await createTestUser(db);

    await recordPasswordChanged(db, { userId: person.id });

    const audits = await auditsFor(person.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("user.password_changed");
    expect(audits[0].actorId).toBe(person.id);
  });

  it("recusa usuário inexistente", async () => {
    await expectServiceError(
      recordPasswordChanged(db, {
        userId: "00000000-0000-4000-8000-0000000000ff",
      }),
      "nao_encontrado",
    );
  });
});

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

describe("listUsers", () => {
  it("mostra a situação de cada acesso", async () => {
    const convidada = await createUser(db, deps, {
      ...invite,
      email: "convidada@loja.com",
      fullName: "Convidada",
    });
    const comSenha = await createUser(db, deps, {
      ...withPassword,
      email: "comsenha@loja.com",
      fullName: "Com Senha",
    });
    const desativada = await createTestUser(db, {
      fullName: "Desativada",
      isActive: false,
    });

    const list = await listUsers(db);
    const byId = new Map(list.map((item) => [item.id, item]));

    expect(byId.get(convidada.user.id)?.status).toBe("convite_pendente");
    expect(byId.get(comSenha.user.id)?.status).toBe("ativo");
    expect(byId.get(desativada.id)?.status).toBe("desativado");
    // Quem veio do script legado (sem audit de criação) já tem senha.
    expect(byId.get(FIXED_USER_ID)?.status).toBe("ativo");
  });

  it("sai do convite pendente quando a pessoa cria a senha", async () => {
    const created = await createUser(db, deps, invite);
    await recordPasswordChanged(db, { userId: created.user.id });

    const list = await listUsers(db);
    expect(list.find((item) => item.id === created.user.id)?.status).toBe(
      "ativo",
    );
  });

  it("sai do convite pendente quando o dono entrega senha provisória", async () => {
    const created = await createUser(db, deps, invite);
    await resetUserPassword(db, deps, {
      actorId: FIXED_USER_ID,
      userId: created.user.id,
      mode: "password",
    });

    const list = await listUsers(db);
    expect(list.find((item) => item.id === created.user.id)?.status).toBe(
      "ativo",
    );
  });

  it("ordena por nome, sem diferenciar maiúsculas", async () => {
    await createTestUser(db, { fullName: "ana" });
    await createTestUser(db, { fullName: "Bruno" });

    const names = (await listUsers(db)).map((item) => item.fullName);
    expect(names).toEqual(["ana", "Bruno", "Testador"]);
  });
});

describe("getUserDetail", () => {
  it("traz situação e histórico com o nome de quem agiu", async () => {
    const created = await createUser(db, deps, invite);
    await updateUser(db, {
      actorId: FIXED_USER_ID,
      userId: created.user.id,
      fullName: "Ana Souza Lima",
    });

    const detail = await getUserDetail(db, created.user.id);

    expect(detail.status).toBe("convite_pendente");
    expect(detail.history.map((entry) => entry.action)).toEqual([
      "user.update",
      "user.create",
    ]);
    expect(detail.history[0].actorName).toBe("Testador");
  });

  it("recusa id inexistente", async () => {
    await expectServiceError(
      getUserDetail(db, "00000000-0000-4000-8000-0000000000ff"),
      "nao_encontrado",
    );
  });
});

// ---------------------------------------------------------------------------
// Escape nos e-mails (o nome e o link são texto de terceiro dentro de HTML)
// ---------------------------------------------------------------------------

describe("escape no e-mail de acesso", () => {
  it("escapa o nome de quem recebe e de quem convidou", async () => {
    await db
      .update(schema.users)
      .set({ fullName: "Fabiano <b>Dono</b>" })
      .where(eq(schema.users.id, FIXED_USER_ID));

    await createUser(db, deps, {
      ...invite,
      fullName: '<script>alert("x")</script> Eva',
      sendEmail: true,
    });

    const [sent] = email.sentEmails;
    expect(sent.html).not.toContain("<script>");
    expect(sent.html).not.toContain("<b>Dono</b>");
    expect(sent.html).toContain("&lt;script&gt;");
    expect(sent.html).toContain("&lt;b&gt;Dono&lt;/b&gt;");
  });

  it("escapa o & do link dentro do href", async () => {
    await createUser(db, deps, { ...invite, sendEmail: true });

    const [sent] = email.sentEmails;
    expect(sent.html).toContain("&amp;type=invite");
    expect(sent.html).not.toContain("&type=invite");
  });

  it("escapa o & do link também na recuperação", async () => {
    const person = await createTestUser(db, { email: "ana@loja.com" });
    identity.seed({ id: person.id, email: "ana@loja.com" });

    await requestPasswordReset(db, deps, { email: "ana@loja.com" });

    const [sent] = email.sentEmails;
    expect(sent.html).toContain("&amp;type=recovery");
    expect(sent.html).not.toContain("&type=recovery");
  });
});
