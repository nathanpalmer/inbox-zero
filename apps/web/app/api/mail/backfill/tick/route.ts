import { NextResponse } from "next/server";
import { z } from "zod";
import { BackfillRunStatus } from "@/generated/prisma/enums";
import { loadEmails } from "@/utils/actions/stats-loading";
import { createEmailProvider } from "@/utils/email/provider";
import { isValidInternalApiKey } from "@/utils/internal-api";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueMailBackfillTick } from "@/utils/queue/mail-backfill";

export const maxDuration = 300;

// A tick must finish inside the worker's 300s forward timeout. loadEmails
// defaults to MAX_PAGES=50 at PAGE_SIZE=20 (~1,000 messages, ~19 minutes at the
// measured rate), so cap it far below that.
const MAX_PAGES_PER_TICK = 10;
const MAX_CONSECUTIVE_FAILURES = 5;

const logger = createScopedLogger("mail/backfill/tick");

const bodySchema = z.object({ runId: z.string().min(1) });

export async function POST(request: Request) {
  if (!isValidInternalApiKey(request.headers, logger)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const run = await prisma.backfillRun.findUnique({
    where: { id: parsed.data.runId },
    include: {
      emailAccount: {
        include: { account: { select: { provider: true } } },
      },
    },
  });

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // A paused, completed or failed run must not be resurrected by a late tick.
  if (run.status !== BackfillRunStatus.RUNNING) {
    return NextResponse.json({ skipped: true, status: run.status });
  }

  try {
    const emailProvider = await createEmailProvider({
      emailAccountId: run.emailAccountId,
      provider: run.emailAccount.account.provider,
      logger,
    });

    const result = await loadEmails(
      { emailAccountId: run.emailAccountId, emailProvider, logger },
      { loadBefore: true, maxPages: MAX_PAGES_PER_TICK },
    );

    const processed = result.loadedAfterMessages + result.loadedBeforeMessages;

    // Completion keys off the BACKFILL direction only. The "after" pass tops up
    // new mail and stays true on any active mailbox, so it must never keep a
    // run alive on its own.
    const done = !result.hasMoreBefore;

    await prisma.backfillRun.update({
      where: { id: run.id },
      data: {
        processed: { increment: processed },
        hasMoreAfter: result.hasMoreAfter,
        hasMoreBefore: result.hasMoreBefore,
        consecutiveFailures: 0,
        lastError: null,
        ...(done
          ? { status: BackfillRunStatus.COMPLETED, completedAt: new Date() }
          : {}),
      },
    });

    if (!done) await enqueueMailBackfillTick({ runId: run.id, logger });

    logger.info("Backfill tick", { runId: run.id, processed, done });

    return NextResponse.json({ ok: true, processed, done });
  } catch (error) {
    const failures = run.consecutiveFailures + 1;
    const terminal = failures >= MAX_CONSECUTIVE_FAILURES;

    await prisma.backfillRun.update({
      where: { id: run.id },
      data: {
        consecutiveFailures: failures,
        lastError: error instanceof Error ? error.message : String(error),
        ...(terminal ? { status: BackfillRunStatus.FAILED } : {}),
      },
    });

    logger.error("Backfill tick failed", {
      runId: run.id,
      failures,
      terminal,
      error,
    });

    // Throwing lets the queue retry a transient failure. A terminal failure must
    // stop retrying, so it reports success and leaves the run marked FAILED.
    if (terminal) return NextResponse.json({ ok: false, terminal: true });
    throw error;
  }
}
