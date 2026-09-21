// Rota de inscrição do Web Push: auth interna (401 em JSON, sem redirect) e
// Zod no corpo. O banco e o service são dublês: aqui só a rota importa.
import { afterEach, describe, expect, it, vi } from "vitest";

let currentUser: { id: string } | null = null;
const upserts: unknown[] = [];
const removals: unknown[] = [];
vi.mock("@/services/auth", () => ({ getAuthUserOrNull: async () => currentUser }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/services/push-subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/push-subscriptions")>();
  return {
    ...actual,
    upsertPushSubscription: async (_db: unknown, input: unknown) => {
      upserts.push(input);
      return { id: "sub-1" };
    },
    removePushSubscription: async (_db: unknown, input: unknown) => {
      removals.push(input);
      return { removed: true };
    },
  };
});
const { DELETE, POST } = await import("@/app/admin/push/subscriptions/route");

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const json = (method: string, body: unknown) =>
  new Request("http://localhost/admin/push/subscriptions", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/admin/push/subscriptions", () => {
  afterEach(() => {
    currentUser = null;
    upserts.length = 0;
    removals.length = 0;
  });

  it("sem sessão: 401 em JSON, sem tocar no banco", async () => {
    const response = await POST(json("POST", { endpoint: "https://push.example/a", keys: KEYS }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "nao_autenticado" });
    expect((await DELETE(json("DELETE", { endpoint: "https://push.example/a" }))).status).toBe(401);
    expect(upserts).toHaveLength(0);
  });

  it("corpo inválido: 400; corpo certo grava para o usuário da sessão", async () => {
    currentUser = { id: "00000000-0000-4000-8000-000000000001" };
    expect((await POST(json("POST", { endpoint: "http://inseguro/a", keys: KEYS }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/admin/push/subscriptions", { method: "POST", body: "não é json" }))).status).toBe(400);

    const ok = await POST(json("POST", { endpoint: "https://push.example/a", keys: KEYS, userAgent: "Safari" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ ok: true, id: "sub-1" });
    expect(upserts).toEqual([{ userId: currentUser.id, endpoint: "https://push.example/a", keys: KEYS, userAgent: "Safari" }]);

    const removed = await DELETE(json("DELETE", { endpoint: "https://push.example/a" }));
    expect(await removed.json()).toEqual({ ok: true, removed: true });
    expect(removals).toEqual([{ userId: currentUser.id, endpoint: "https://push.example/a" }]);
  });
});
