// Provedor de identidade FAKE: espelha o comportamento do GoTrue em memória.
// É o que permite testar o service de usuários inteiro no PGlite e rodar o
// painel em dev sem tocar no Supabase.
import { randomUUID } from "node:crypto";

import {
  IdentityError,
  type AccessLink,
  type CreateIdentityUserInput,
  type GenerateAccessLinkInput,
  type IdentityErrorCode,
  type IdentityProvider,
  type IdentityUser,
} from "./index";

export type FakeIdentityMethod =
  | "findByEmail"
  | "createUser"
  | "generateAccessLink"
  | "setPassword"
  | "setBanned"
  | "deleteUser";

/** Conta do fake: o IdentityUser + a senha (que o provedor real nunca devolve). */
export type FakeIdentityRecord = IdentityUser & { password: string | null };

export type SeedIdentityUserInput = {
  email: string;
  id?: string;
  fullName?: string | null;
  password?: string | null;
  /** Padrão: confirmado (conta pronta para entrar). */
  emailConfirmedAt?: Date | null;
  banned?: boolean;
  createdAt?: Date;
};

const DEFAULT_ERROR_MESSAGES: Record<IdentityErrorCode, string> = {
  email_ja_existe: "Já existe uma conta de acesso com esse e-mail.",
  usuario_nao_encontrado: "Conta de acesso não encontrada.",
  nao_configurado:
    "Gerenciamento de contas indisponível: provedor não configurado.",
  indisponivel:
    "Não foi possível falar com o serviço de contas agora. Tente de novo em " +
    "alguns instantes.",
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toIdentityUser(record: FakeIdentityRecord): IdentityUser {
  const { password: _password, ...user } = record;
  return { ...user };
}

export class FakeIdentityProvider implements IdentityProvider {
  readonly users: FakeIdentityRecord[] = [];
  readonly links: AccessLink[] = [];

  /**
   * Em dev o dono precisa VER a senha/link no terminal (não há e-mail
   * configurado); na suíte de testes isso só polui a saída.
   */
  logToConsole = !process.env.VITEST;

  private tokenSequence = 0;
  private readonly nextFailures = new Map<FakeIdentityMethod, IdentityError>();

  // --- Helpers de teste/dev (fora da interface IdentityProvider) ---

  /** Cria uma conta já existente, sem passar pelas regras de createUser. */
  seed(input: SeedIdentityUserInput): IdentityUser {
    const record: FakeIdentityRecord = {
      id: input.id ?? randomUUID(),
      email: normalizeEmail(input.email),
      fullName: input.fullName ?? null,
      emailConfirmedAt:
        input.emailConfirmedAt === undefined ? new Date() : input.emailConfirmedAt,
      banned: input.banned ?? false,
      createdAt: input.createdAt ?? new Date(),
      password: input.password ?? null,
    };
    this.users.push(record);
    return toIdentityUser(record);
  }

  /** Faz a PRÓXIMA chamada de `method` falhar com esse código. */
  failNext(
    method: FakeIdentityMethod,
    error: IdentityErrorCode,
    message?: string,
  ): void {
    this.nextFailures.set(
      method,
      new IdentityError(error, message ?? DEFAULT_ERROR_MESSAGES[error]),
    );
  }

  reset(): void {
    this.users.length = 0;
    this.links.length = 0;
    this.tokenSequence = 0;
    this.nextFailures.clear();
  }

  private consumeFailure(method: FakeIdentityMethod): void {
    const failure = this.nextFailures.get(method);
    if (!failure) return;
    this.nextFailures.delete(method);
    throw failure;
  }

  private findRecordByEmail(email: string): FakeIdentityRecord | undefined {
    const wanted = normalizeEmail(email);
    return this.users.find((user) => user.email === wanted);
  }

  private requireRecordById(userId: string): FakeIdentityRecord {
    const record = this.users.find((user) => user.id === userId);
    if (!record) {
      throw new IdentityError(
        "usuario_nao_encontrado",
        DEFAULT_ERROR_MESSAGES.usuario_nao_encontrado,
      );
    }
    return record;
  }

  private log(message: string): void {
    if (!this.logToConsole) return;
    console.info(`[identity:fake] ${message}`);
  }

  // --- Contrato IdentityProvider ---

  async findByEmail(email: string): Promise<IdentityUser | null> {
    this.consumeFailure("findByEmail");
    const record = this.findRecordByEmail(email);
    return record ? toIdentityUser(record) : null;
  }

  async createUser(input: CreateIdentityUserInput): Promise<IdentityUser> {
    this.consumeFailure("createUser");
    if (this.findRecordByEmail(input.email)) {
      throw new IdentityError(
        "email_ja_existe",
        DEFAULT_ERROR_MESSAGES.email_ja_existe,
      );
    }
    const record: FakeIdentityRecord = {
      id: randomUUID(),
      email: normalizeEmail(input.email),
      fullName: input.fullName ?? null,
      emailConfirmedAt: (input.emailConfirm ?? true) ? new Date() : null,
      banned: false,
      createdAt: new Date(),
      password: input.password ?? null,
    };
    this.users.push(record);
    if (input.password) {
      this.log(`senha de ${record.email}: ${input.password}`);
    }
    return toIdentityUser(record);
  }

  async generateAccessLink(input: GenerateAccessLinkInput): Promise<AccessLink> {
    this.consumeFailure("generateAccessLink");
    const email = normalizeEmail(input.email);
    let record = this.findRecordByEmail(email);

    if (input.type === "recovery") {
      if (!record) {
        throw new IdentityError(
          "usuario_nao_encontrado",
          DEFAULT_ERROR_MESSAGES.usuario_nao_encontrado,
        );
      }
    } else if (record) {
      // Igual ao GoTrue: convite para conta JÁ confirmada é recusado — nesse
      // caso o tipo certo é "recovery".
      if (record.emailConfirmedAt !== null) {
        throw new IdentityError(
          "email_ja_existe",
          DEFAULT_ERROR_MESSAGES.email_ja_existe,
        );
      }
    } else {
      // Convite para e-mail novo CRIA a conta (ainda não confirmada).
      record = {
        id: randomUUID(),
        email,
        fullName: null,
        emailConfirmedAt: null,
        banned: false,
        createdAt: new Date(),
        password: null,
      };
      this.users.push(record);
    }

    this.tokenSequence += 1;
    const tokenHash = `fake-token-${this.tokenSequence}`;
    const redirect = input.redirectTo
      ? `&redirect_to=${encodeURIComponent(input.redirectTo)}`
      : "";
    const link: AccessLink = {
      user: toIdentityUser(record),
      type: input.type,
      tokenHash,
      actionLink:
        `https://fake-identity.local/auth/v1/verify?token=${tokenHash}` +
        `&type=${input.type}${redirect}`,
    };
    this.links.push(link);
    this.log(`link (${input.type}) de ${email}: token_hash=${tokenHash}`);
    return link;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    this.consumeFailure("setPassword");
    const record = this.requireRecordById(userId);
    record.password = password;
    this.log(`senha de ${record.email}: ${password}`);
  }

  async setBanned(userId: string, banned: boolean): Promise<void> {
    this.consumeFailure("setBanned");
    const record = this.requireRecordById(userId);
    record.banned = banned;
  }

  async deleteUser(userId: string): Promise<void> {
    this.consumeFailure("deleteUser");
    const index = this.users.findIndex((user) => user.id === userId);
    if (index === -1) {
      throw new IdentityError(
        "usuario_nao_encontrado",
        DEFAULT_ERROR_MESSAGES.usuario_nao_encontrado,
      );
    }
    this.users.splice(index, 1);
  }
}
