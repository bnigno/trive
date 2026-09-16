// Rotina do Inngest falhou → o dono sabe (WhatsApp + e-mail), 1x por hora
// por rotina, e o alerta nunca alerta a si mesmo.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmailProvider } from "@/adapters/email/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { alertFunctionFailure, FUNCTION_FAILURE_ALERT_COOLDOWN_MS } from "@/services/system-alerts";
import { createTestDb, type TestDb } from "../helpers/db";

describe("alertFunctionFailure", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  let provider: FakeMessagingProvider;
  let email: FakeEmailProvider;
  const now = new Date("2026-09-16T11:07:00Z");

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    provider = new FakeMessagingProvider();
    email = new FakeEmailProvider();
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "owner_whatsapp_phone", value: "+5511988887777" },
    ]);
  });

  afterEach(async () => {
    await close();
  });

  it("avisa por WhatsApp e e-mail com o nome da rotina e o erro; a segunda falha na mesma hora não repete; outra rotina avisa", async () => {
    const first = await alertFunctionFailure(sdb, provider, {
      functionId: "trive-daily-digest",
      runId: "run-1",
      message: '[\n  {\n    "code": "invalid_format",\n    "path": ["aggregateId"],\n    "message": "Invalid UUID"\n  }\n]',
      now,
      emailProvider: email,
    });
    expect(first).toEqual({ alerted: true, via: ["whatsapp", "email"] });
    const owner = provider.sentMessages.filter((m) => m.toE164 === "+5511988887777");
    expect(owner).toHaveLength(1);
    expect(owner[0].body).toContain("resumo diário (Bom dia)");
    expect(owner[0].body).toContain("Invalid UUID");
    expect(owner[0].body).not.toContain("\n  {");
    expect(email.sentEmails[0].subject).toContain("resumo diário (Bom dia)");

    const again = await alertFunctionFailure(sdb, provider, { functionId: "trive-daily-digest", runId: "run-2", message: "de novo", now: new Date(now.getTime() + 30 * 60_000), emailProvider: email });
    expect(again).toEqual({ skipped: "em_cooldown" });

    const later = await alertFunctionFailure(sdb, provider, { functionId: "trive-daily-digest", runId: "run-3", message: "ainda", now: new Date(now.getTime() + FUNCTION_FAILURE_ALERT_COOLDOWN_MS + 1000), emailProvider: email });
    expect(later).toMatchObject({ alerted: true });

    const other = await alertFunctionFailure(sdb, provider, { functionId: "trive-email-poll", runId: "run-4", message: "mime type application/pdf is not supported", now, emailProvider: email });
    expect(other).toMatchObject({ alerted: true });
    expect(provider.sentMessages.filter((m) => m.toE164 === "+5511988887777")).toHaveLength(3);

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "system.function_failed_alert"));
    expect(audits.map((a) => a.entityId)).toEqual(["trive-daily-digest", "trive-daily-digest", "trive-email-poll"]);
  });

  it("a própria função de alerta falhando não gera alerta (sem loop); sem dono alcançável, pula", async () => {
    expect(await alertFunctionFailure(sdb, provider, { functionId: "trive-function-failure-alert", runId: "r", message: "x", now, emailProvider: email })).toEqual({ skipped: "proprio_alerta" });
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "wa_enabled"));
    await db.update(schema.users).set({ isActive: false });
    expect(await alertFunctionFailure(sdb, provider, { functionId: "trive-outbox-sweep", runId: "r", message: "x", now, emailProvider: email })).toEqual({ skipped: "sem_dono" });
  });
});
