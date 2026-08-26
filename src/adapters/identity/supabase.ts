// Adapter REAL de identidade: Admin API do GoTrue (Supabase Auth) via fetch
// nativo + Zod na fronteira — mesmo estilo do ResendEmailProvider, sem SDK.
//
// Autenticação: headers `apikey` E `Authorization: Bearer` com a
// SUPABASE_SERVICE_ROLE_KEY (chave de servidor; nunca chega ao navegador).
// Erros NUNCA repetem a chave nem a URL completa — só status e caminho.
import { z } from "zod";

import {
  IdentityError,
  type AccessLink,
  type CreateIdentityUserInput,
  type GenerateAccessLinkInput,
  type IdentityProvider,
  type IdentityUser,
} from "./index";

// Duração usada como "banido para sempre" (100 anos). O GoTrue não tem
// desativação booleana: `ban_duration` "none" reativa.
const FOREVER_BAN_DURATION = "876000h";

// A Admin API não filtra por e-mail: listamos a primeira página e casamos
// aqui. LIMITAÇÃO CONSCIENTE: contas além das 200 primeiras não são
// encontradas. A operação tem o dono + punhado de funcionários; se um dia
// passar disso, este método precisa paginar (page=2, 3, … até vir vazio).
const LIST_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Schemas da fronteira (loose: o GoTrue devolve MUITO mais campos do que
// usamos, e novos campos aparecem entre versões — ignorar é o certo).
// ---------------------------------------------------------------------------

const gotrueUserSchema = z.looseObject({
  id: z.uuid(),
  email: z.string().nullish(),
  email_confirmed_at: z.string().nullish(),
  banned_until: z.string().nullish(),
  created_at: z.string().nullish(),
  user_metadata: z.looseObject({ full_name: z.string().nullish() }).nullish(),
});

type GotrueUser = z.infer<typeof gotrueUserSchema>;

const listUsersResponseSchema = z.looseObject({
  users: z.array(gotrueUserSchema),
});

// Resposta de /admin/generate_link é PLANA: os campos do link vêm no MESMO
// nível dos campos do usuário (o Go embute a struct User). Não existe
// { properties, user } aqui — isso é formato de SDK, não do REST.
const generateLinkResponseSchema = gotrueUserSchema.extend({
  action_link: z.string(),
  hashed_token: z.string().min(1),
  email_otp: z.string().nullish(),
  redirect_to: z.string().nullish(),
  verification_type: z.string().nullish(),
});

const gotrueErrorSchema = z.looseObject({
  error_code: z.string().nullish(),
  msg: z.string().nullish(),
  message: z.string().nullish(),
  error: z.string().nullish(),
  error_description: z.string().nullish(),
});

// ---------------------------------------------------------------------------

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIdentityUser(raw: GotrueUser): IdentityUser {
  const bannedUntil = parseDate(raw.banned_until);
  return {
    id: raw.id,
    email: raw.email ?? "",
    fullName: raw.user_metadata?.full_name ?? null,
    emailConfirmedAt: parseDate(raw.email_confirmed_at),
    banned: bannedUntil !== null && bannedUntil.getTime() > Date.now(),
    createdAt: parseDate(raw.created_at),
  };
}

type Credentials = { baseUrl: string; serviceRoleKey: string };

function getCredentials(): Credentials {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new IdentityError(
      "nao_configurado",
      "Gerenciamento de contas indisponível: faltam NEXT_PUBLIC_SUPABASE_URL " +
        "e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.",
    );
  }
  return { baseUrl: url.replace(/\/+$/, ""), serviceRoleKey };
}

function readErrorDetail(body: unknown): {
  errorCode: string | null;
  message: string | null;
} {
  const parsed = gotrueErrorSchema.safeParse(body);
  if (!parsed.success) return { errorCode: null, message: null };
  const { error_code, msg, message, error, error_description } = parsed.data;
  return {
    errorCode: error_code ?? null,
    message: msg ?? message ?? error_description ?? error ?? null,
  };
}

export class SupabaseIdentityProvider implements IdentityProvider {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  private async request(
    path: string,
    init?: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const { baseUrl, serviceRoleKey } = getCredentials();

    let response: Response;
    try {
      response = await this.fetchFn(`${baseUrl}/auth/v1${path}`, {
        method: init?.method ?? "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          ...(init?.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(init?.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
      });
    } catch {
      throw new IdentityError(
        "indisponivel",
        "Não foi possível falar com o serviço de contas agora. Tente de novo " +
          "em alguns instantes.",
      );
    }

    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Corpo não-JSON: seguimos só com o status HTTP.
      }
      throw this.toIdentityError(response.status, path, body);
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      return {};
    }
  }

  private toIdentityError(
    status: number,
    path: string,
    body: unknown,
  ): IdentityError {
    const { errorCode, message } = readErrorDetail(body);

    // Duplicidade de e-mail: o GoTrue responde 422 (algumas versões 409). O
    // `error_code` só existe nas versões novas — por isso o 422 "sem código"
    // cai aqui também: nas chamadas que fazemos, é o motivo dominante.
    const isDuplicate =
      errorCode === "email_exists" ||
      errorCode === "user_already_exists" ||
      (message !== null && /already\s+(been\s+)?(registered|exists)/i.test(message)) ||
      ((status === 422 || status === 409) && errorCode === null);
    if (isDuplicate) {
      return new IdentityError(
        "email_ja_existe",
        "Já existe uma conta de acesso com esse e-mail.",
      );
    }

    if (status === 404) {
      return new IdentityError(
        "usuario_nao_encontrado",
        "Conta de acesso não encontrada.",
      );
    }

    return new IdentityError(
      "indisponivel",
      `O serviço de contas respondeu HTTP ${status} em ${path}` +
        (message ? `: ${message}` : "."),
    );
  }

  async findByEmail(email: string): Promise<IdentityUser | null> {
    const raw = await this.request(
      `/admin/users?page=1&per_page=${LIST_PAGE_SIZE}`,
    );
    const parsed = listUsersResponseSchema.parse(raw);
    const wanted = email.trim().toLowerCase();
    // GoTrue guarda o e-mail em minúsculas, mas comparamos sem diferenciar
    // maiúsculas para não criar conta duplicada por digitação.
    const found = parsed.users.find(
      (user) => (user.email ?? "").toLowerCase() === wanted,
    );
    return found ? toIdentityUser(found) : null;
  }

  async createUser(input: CreateIdentityUserInput): Promise<IdentityUser> {
    const raw = await this.request("/admin/users", {
      method: "POST",
      body: {
        email: input.email.trim().toLowerCase(),
        email_confirm: input.emailConfirm ?? true,
        ...(input.password !== undefined ? { password: input.password } : {}),
        ...(input.fullName ? { user_metadata: { full_name: input.fullName } } : {}),
      },
    });
    return toIdentityUser(gotrueUserSchema.parse(raw));
  }

  async generateAccessLink(input: GenerateAccessLinkInput): Promise<AccessLink> {
    const raw = await this.request("/admin/generate_link", {
      method: "POST",
      body: {
        type: input.type,
        email: input.email.trim().toLowerCase(),
        ...(input.redirectTo !== undefined
          ? { redirect_to: input.redirectTo }
          : {}),
      },
    });
    const parsed = generateLinkResponseSchema.parse(raw);
    return {
      user: toIdentityUser(parsed),
      type: input.type,
      tokenHash: parsed.hashed_token,
      actionLink: parsed.action_link,
    };
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.request(`/admin/users/${userId}`, {
      method: "PUT",
      body: { password },
    });
  }

  async setBanned(userId: string, banned: boolean): Promise<void> {
    await this.request(`/admin/users/${userId}`, {
      method: "PUT",
      body: { ban_duration: banned ? FOREVER_BAN_DURATION : "none" },
    });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}`, { method: "DELETE" });
  }
}
