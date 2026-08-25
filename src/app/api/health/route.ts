import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

type QueueStats = {
  oldestPendingAgeSeconds: number;
  deadCount: number;
};

type HealthBody = {
  status: "ok" | "degraded";
  db: "ok" | "error" | "unconfigured";
  queue: QueueStats | null;
};

// Sonda de uptime: sempre HTTP 200, nunca lança; problemas viram 'degraded'.
export async function GET(): Promise<NextResponse<HealthBody>> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      status: "degraded",
      db: "unconfigured",
      queue: null,
    });
  }

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);

    const rows = (await db.execute(sql`
      SELECT
        COALESCE(
          EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing', 'failed')
          )))::int,
          0
        ) AS oldest_pending_age_seconds,
        COUNT(*) FILTER (WHERE status = 'dead')::int AS dead_count
      FROM outbox_events
    `)) as unknown as {
      oldest_pending_age_seconds: number;
      dead_count: number;
    }[];

    const stats = rows[0];
    return NextResponse.json({
      status: "ok",
      db: "ok",
      queue: {
        oldestPendingAgeSeconds: Number(stats?.oldest_pending_age_seconds ?? 0),
        deadCount: Number(stats?.dead_count ?? 0),
      },
    });
  } catch {
    return NextResponse.json({
      status: "degraded",
      db: "error",
      queue: null,
    });
  }
}
