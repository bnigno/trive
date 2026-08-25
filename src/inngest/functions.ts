import { getDb } from "@/db/client";
import { inngest } from "@/inngest/client";
import { drainOutbox, type DrainOutboxResult } from "@/queue/worker";

const SWEEP_BATCH_LIMIT = 25;
const SWEEP_MAX_BATCHES = 10;

export const outboxSweep = inngest.createFunction(
  { id: "outbox-sweep", triggers: [{ cron: "* * * * *" }] },
  async () => {
    const db = getDb();
    const totals: DrainOutboxResult = {
      recovered: 0,
      claimed: 0,
      done: 0,
      failed: 0,
      dead: 0,
    };
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const result = await drainOutbox(db, { limit: SWEEP_BATCH_LIMIT });
      totals.recovered += result.recovered;
      totals.claimed += result.claimed;
      totals.done += result.done;
      totals.failed += result.failed;
      totals.dead += result.dead;
      if (result.claimed === 0) break;
    }
    return totals;
  },
);

export const outboxKick = inngest.createFunction(
  { id: "outbox-kick", triggers: [{ event: "outbox/event.enqueued" }] },
  async () => {
    return drainOutbox(getDb(), { limit: 10 });
  },
);

export const functions = [outboxSweep, outboxKick];
