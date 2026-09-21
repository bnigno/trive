// Inscrições de Web Push: uma por aparelho, presa ao usuário; o endpoint é a identidade.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  countPushSubscriptionsByUser,
  hasPushSubscription,
  listActivePushSubscriptions,
  pushSubscriptionInputSchema,
  removePushSubscription,
  upsertPushSubscription,
} from "@/services/push-subscriptions";

import { createTestDb, createTestUser, FIXED_USER_ID, type TestDb } from "../helpers/db";

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

describe("push-subscriptions", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
  });
  afterEach(async () => {
    await close();
  });

  it("recusa endpoint http, chave fora de base64url e corpo sem keys", () => {
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: "http://push.example/x", keys: KEYS }).success).toBe(false);
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: "https://push.example/x", keys: { p256dh: "não é base64!", auth: KEYS.auth } }).success).toBe(false);
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: "https://push.example/x" }).success).toBe(false);
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: "https://push.example/x", keys: KEYS, userAgent: null }).success).toBe(true);
  });

  it("upsert pelo endpoint: o mesmo endpoint de novo troca chaves e usuário em vez de duplicar; remove só a do próprio usuário", async () => {
    const staff = await createTestUser(db, { role: "staff" });
    const first = await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/a", keys: KEYS, userAgent: "Safari iPhone" });
    const again = await upsertPushSubscription(sdb, { userId: staff.id, endpoint: "https://push.example/a", keys: { ...KEYS, auth: "outra_auth_valida_aqui" } });
    expect(again.id).toBe(first.id);
    const rows = await db.select().from(schema.pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: staff.id, auth: "outra_auth_valida_aqui", userAgent: null });

    expect(await hasPushSubscription(sdb, { userId: staff.id, endpoint: "https://push.example/a" })).toBe(true);
    expect(await hasPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/a" })).toBe(false);
    // O dono não apaga a inscrição da equipe (não é dele).
    expect(await removePushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/a" })).toEqual({ removed: false });
    expect(await removePushSubscription(sdb, { userId: staff.id, endpoint: "https://push.example/a" })).toEqual({ removed: true });
    expect(await db.select().from(schema.pushSubscriptions)).toHaveLength(0);
  });

  it("lista só inscrições de usuários ativos; apagar o usuário leva as inscrições junto", async () => {
    const inactive = await createTestUser(db, { isActive: false });
    const staff = await createTestUser(db);
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/owner", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: staff.id, endpoint: "https://push.example/staff-1", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: staff.id, endpoint: "https://push.example/staff-2", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: inactive.id, endpoint: "https://push.example/inactive", keys: KEYS });

    const active = await listActivePushSubscriptions(sdb);
    expect(active.map((row) => row.endpoint).sort()).toEqual(["https://push.example/owner", "https://push.example/staff-1", "https://push.example/staff-2"]);
    expect(await countPushSubscriptionsByUser(sdb, staff.id)).toBe(2);

    await db.delete(schema.users).where((await import("drizzle-orm")).eq(schema.users.id, staff.id));
    expect((await listActivePushSubscriptions(sdb)).map((row) => row.endpoint)).toEqual(["https://push.example/owner"]);
  });
});
