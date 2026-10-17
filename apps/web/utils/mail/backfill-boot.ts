import "server-only";

import { BackfillRunStatus } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueMailBackfillTick } from "@/utils/queue/mail-backfill";
import { sleep } from "@/utils/sleep";

const logger = createScopedLogger("mail/backfill/boot");

const ENQUEUE_ATTEMPTS = 3;

/**
 * Re-arm queue-driven mailbox backfills when the server starts.
 *
 * A backfill tick re-enqueues the next tick, so a RUNNING run only stalls when
 * its chain is lost — which every restart does, including the nightly backup.
 * Recovery used to depend on the cron backstop, but that sidecar starts before
 * the web server is listening: its first resume call fails and the next one is
 * 15 minutes away. Re-arming on boot closes that window (and also covers
 * crashes and deploys).
 *
 * Enqueue failures are retried briefly because Redis may still be starting
 * alongside this process; after that the cron backstop remains the safety net.
 */
export async function resumeRunningBackfills(): Promise<number> {
  const runs = await prisma.backfillRun.findMany({
    where: { status: BackfillRunStatus.RUNNING },
    select: { id: true },
    take: 50,
  });

  for (const run of runs) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt++) {
      try {
        await enqueueMailBackfillTick({ runId: run.id, logger });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await sleep(2000 * attempt);
      }
    }

    if (lastError) {
      logger.error("Failed to re-arm backfill on boot", {
        runId: run.id,
        error: lastError,
      });
    }
  }

  if (runs.length > 0) {
    logger.info("Re-armed backfills on boot", { count: runs.length });
  }

  return runs.length;
}
