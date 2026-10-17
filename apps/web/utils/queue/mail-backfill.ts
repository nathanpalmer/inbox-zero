import "server-only";

import type { Logger } from "@/utils/logger";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";

export const MAIL_BACKFILL_QUEUE = "mail-backfill";

/**
 * Enqueue one bounded backfill tick.
 *
 * A tick processes a small number of pages and enqueues the next tick itself,
 * so no single job runs long enough to hit the worker's per-request timeout,
 * and progress is committed to the database between ticks.
 */
export async function enqueueMailBackfillTick({
  runId,
  logger,
}: {
  runId: string;
  logger: Logger;
}) {
  return enqueueBackgroundJob({
    topic: MAIL_BACKFILL_QUEUE,
    body: { runId },
    qstash: {
      queueName: MAIL_BACKFILL_QUEUE,
      // One tick at a time: two ticks would race over the same derived cursor.
      parallelism: 1,
      path: "/api/mail/backfill/tick",
    },
    logger,
  });
}
