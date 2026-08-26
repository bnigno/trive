import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SupabaseIdentityProvider } from "@/adapters/identity/supabase";

type RecordedCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
};

/** Fetch fake injetável: grava as chamadas e responde o payload configurado. */
function createFakeFetch(payload: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const USER_ID = "11111111-1111-4111-8111-111111111111";

/** Usuário como o GoTrue devolve (recortado nos campos que consumimos). */
function gotrueUser(over: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "maria@loja.com.br",
    email_confirmed_at: "2026-08-20T10:00:00Z",
    created_at: "2026-08-20T09:59:00Z",
    user_metadata: { full_name: "Maria da Silva" },
    app_metadata: { provider: "email" },
    ...over,
  };
}

describe("SupabaseIdentityProvider (Admin API com fetch fake)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://projeto.supabase.co/");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-de-teste");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createUser faz POST /auth/v1/admin/users com apikey + Bearer", async () => {
    const { calls, fetchFn } = createFakeFetch(gotrueUser());
    const provider = new SupabaseIdentityProvider(fetchFn);

    const user = await provider.createUser({
      email: "  Maria@Loja.com.BR ",
      fullName: "Maria da Silva",
      password: "senha-provisoria-123",
    });

    expect(user).toMatchObject({
      id: USER_ID,
      email: "maria@loja.com.br",
      fullName: "Maria da Silva",
      banned: false,
    });
    expect(user.emailConfirmedAt).toBeInstanceOf(Date);
    expect(calls[0]?.url).toBe("https://projeto.supabase.co/auth/v1/admin/users");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.apikey).toBe("service-role-de-teste");
    expect(calls[0]?.headers.Authorization).toBe("Bearer service-role-de-teste");
    expect(calls[0]?.body).toEqual({
      email: "maria@loja.com.br",
      email_confirm: true,
      password: "senha-provisoria-123",
      user_metadata: { full_name: "Maria da Silva" },
    });
  });

  it("generateAccessLink parseia a resposta PLANA do generate_link", async () => {
    // A resposta REST embute os campos do usuário no MESMO nível dos campos
    // do link — não existe { properties, user } aqui.
    const { calls, fetchFn } = createFakeFetch(
      gotrueUser({
        email_confirmed_at: null,
        action_link:
          "https://projeto.supabase.co/auth/v1/verify?token=abc&type=invite",
        email_otp: "123456",
        hashed_token: "abc123hash",
        redirect_to: "https://trivemaison.com.br/admin/nova-senha",
        verification_type: "invite",
      }),
    );
    const provider = new SupabaseIdentityProvider(fetchFn);

    const link = await provider.generateAccessLink({
      email: "maria@loja.com.br",
      type: "invite",
      redirectTo: "https://trivemaison.com.br/admin/nova-senha",
    });

    expect(link.tokenHash).toBe("abc123hash");
    expect(link.actionLink).toContain("token=abc");
    expect(link.type).toBe("invite");
    expect(link.user).toMatchObject({
      id: USER_ID,
      email: "maria@loja.com.br",
      fullName: "Maria da Silva",
      emailConfirmedAt: null,
    });
    expect(calls[0]?.url).toBe(
      "https://projeto.supabase.co/auth/v1/admin/generate_link",
    );
    expect(calls[0]?.body).toEqual({
      type: "invite",
      email: "maria@loja.com.br",
      redirect_to: "https://trivemaison.com.br/admin/nova-senha",
    });
  });

  it("findByEmail lista a primeira página e casa sem diferenciar maiúsculas", async () => {
    const { calls, fetchFn } = createFakeFetch({
      users: [gotrueUser({ id: USER_ID, email: "maria@loja.com.br" })],
      aud: "authenticated",
    });
    const provider = new SupabaseIdentityProvider(fetchFn);

    const found = await provider.findByEmail("MARIA@Loja.com.br");

    expect(found?.id).toBe(USER_ID);
    expect(calls[0]?.url).toBe(
      "https://projeto.supabase.co/auth/v1/admin/users?page=1&per_page=200",
    );
    expect(calls[0]?.method).toBe("GET");
  });

  it("findByEmail devolve null quando o e-mail não está na lista", async () => {
    const { fetchFn } = createFakeFetch({ users: [gotrueUser()] });
    const provider = new SupabaseIdentityProvider(fetchFn);

    await expect(provider.findByEmail("outro@loja.com.br")).resolves.toBeNull();
  });

  it("banned_until no futuro marca a conta como desativada", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { fetchFn } = createFakeFetch({
      users: [gotrueUser({ banned_until: future })],
    });
    const provider = new SupabaseIdentityProvider(fetchFn);

    const found = await provider.findByEmail("maria@loja.com.br");
    expect(found?.banned).toBe(true);
  });

  it("setPassword e setBanned fazem PUT no usuário", async () => {
    const { calls, fetchFn } = createFakeFetch(gotrueUser());
    const provider = new SupabaseIdentityProvider(fetchFn);

    await provider.setPassword(USER_ID, "nova-senha-456");
    await provider.setBanned(USER_ID, true);
    await provider.setBanned(USER_ID, false);

    expect(calls.map((call) => call.method)).toEqual(["PUT", "PUT", "PUT"]);
    expect(calls[0]?.url).toBe(
      `https://projeto.supabase.co/auth/v1/admin/users/${USER_ID}`,
    );
    expect(calls[0]?.body).toEqual({ password: "nova-senha-456" });
    expect(calls[1]?.body).toEqual({ ban_duration: "876000h" });
    expect(calls[2]?.body).toEqual({ ban_duration: "none" });
  });

  it("deleteUser faz DELETE no usuário", async () => {
    const { calls, fetchFn } = createFakeFetch({});
    const provider = new SupabaseIdentityProvider(fetchFn);

    await provider.deleteUser(USER_ID);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `https://projeto.supabase.co/auth/v1/admin/users/${USER_ID}`,
    );
  });

  it("sem credenciais no ambiente: erro nao_configurado (sem chamar a rede)", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { calls, fetchFn } = createFakeFetch(gotrueUser());
    const provider = new SupabaseIdentityProvider(fetchFn);

    await expect(
      provider.createUser({ email: "maria@loja.com.br" }),
    ).rejects.toMatchObject({ name: "IdentityError", code: "nao_configurado" });
    expect(calls).toHaveLength(0);
  });

  it("422 email_exists vira email_ja_existe", async () => {
    const { fetchFn } = createFakeFetch(
      {
        code: 422,
        error_code: "email_exists",
        msg: "A user with this email address has already been registered",
      },
      422,
    );
    const provider = new SupabaseIdentityProvider(fetchFn);

    await expect(
      provider.createUser({ email: "maria@loja.com.br" }),
    ).rejects.toMatchObject({ code: "email_ja_existe" });
  });

  it("422 sem error_code (GoTrue antigo) também vira email_ja_existe", async () => {
    const { fetchFn } = createFakeFetch(
      { code: 422, msg: "Email address already in use" },
      422,
    );
    const provider = new SupabaseIdentityProvider(fetchFn);

    await expect(
      provider.createUser({ email: "maria@loja.com.br" }),
    ).rejects.toMatchObject({ code: "email_ja_existe" });
  });

  it("404 vira usuario_nao_encontrado", async () => {
    const { fetchFn } = createFakeFetch({ code: 404, msg: "User not found" }, 404);
    const provider = new SupabaseIdentityProvider(fetchFn);

    await expect(
      provider.generateAccessLink({
        email: "ninguem@loja.com.br",
        type: "recovery",
      }),
    ).rejects.toMatchObject({ code: "usuario_nao_encontrado" });
  });

  it("500 vira indisponivel sem vazar a chave de serviço", async () => {
    const { fetchFn } = createFakeFetch({ msg: "internal error" }, 500);
    const provider = new SupabaseIdentityProvider(fetchFn);

    const error = await provider.setPassword(USER_ID, "x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "indisponivel" });
    expect(String((error as Error).message)).not.toContain(
      "service-role-de-teste",
    );
  });

  it("falha de rede vira indisponivel", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new SupabaseIdentityProvider(fetchFn);

    await expect(provider.deleteUser(USER_ID)).rejects.toMatchObject({
      code: "indisponivel",
    });
  });
});
