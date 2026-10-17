import { NextResponse } from "next/server";
import { z } from "zod";
import { BackfillRunStatus } from "@/generated/prisma/enums";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { enqueueMailBackfillTick } from "@/utils/queue/mail-backfill";

const ACTIVE_STATUSES: BackfillRunStatus[] = [
  BackfillRunStatus.QUEUED,
  BackfillRunStatus.RUNNING,
];

const postSchema = z.object({ action: z.enum(["start", "pause"]) });

export const GET = withEmailAccount("mail/backfill", async (request) => {
  const run = await prisma.backfillRun.findFirst({
    where: { emailAccountId: request.auth.emailAccountId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ run });
});

export const POST = withEmailAccount("mail/backfill", async (request) => {
  const { action } = postSchema.parse(await request.json());
  const emailAccountId = request.auth.emailAccountId;

  if (action === "pause") {
    await prisma.backfillRun.updateMany({
      where: { emailAccountId, status: { in: ACTIVE_STATUSES } },
      data: { status: BackfillRunStatus.PAUSED },
    });

    return NextResponse.json({ ok: true });
  }

  // One active run per account: a second driver would race the derived cursor.
  const existing = await prisma.backfillRun.findFirst({
    where: { emailAccountId, status: { in: ACTIVE_STATUSES } },
  });
  if (existing) {
    return NextResponse.json({ run: existing, alreadyRunning: true });
  }

  const run = await prisma.backfillRun.create({
    data: { emailAccountId, status: BackfillRunStatus.RUNNING },
  });

  await enqueueMailBackfillTick({ runId: run.id, logger: request.logger });

  return NextResponse.json({ run });
});
