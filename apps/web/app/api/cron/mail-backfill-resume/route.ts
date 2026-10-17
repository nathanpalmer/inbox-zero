import { NextResponse } from "next/server";
import { BackfillRunStatus } from "@/generated/prisma/enums";
import { hasCronSecret } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { enqueueMailBackfillTick } from "@/utils/queue/mail-backfill";

export const maxDuration = 60;

// A tick re-enqueues the next one, so a RUNNING run should never sit idle for
// long. If it does, its chain was lost — service restart, deploy, crash — and
// it needs re-arming. The nightly backup restarts the service, so this is not
// an edge case on a long backfill.
const STALE_AFTER_MS = 5 * 60 * 1000;

export const GET = withError("cron/mail-backfill-resume", async (request) => {
  if (!hasCronSecret(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const stale = await prisma.backfillRun.findMany({
    where: {
      status: BackfillRunStatus.RUNNING,
      updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    select: { id: true },
    take: 50,
  });

  for (const run of stale) {
    await enqueueMailBackfillTick({ runId: run.id, logger: request.logger });
  }

  return NextResponse.json({ resumed: stale.length });
});
