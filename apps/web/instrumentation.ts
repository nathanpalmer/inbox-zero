/* eslint-disable no-process-env */
import * as Sentry from "@sentry/nextjs";
import { beforeSend, beforeSendTransaction } from "@/utils/sentry-scrub";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("instrumentation");

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // this is your Sentry.init call from `sentry.server.config.js|ts`
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      // Adjust this value in production, or use tracesSampler for greater control
      tracesSampleRate: 0.1,
      // Setting this option to true will print useful information to the console while you're setting up Sentry.
      debug: false,
      // Redact PII/secrets before sending to Sentry (third party).
      beforeSend,
      beforeSendTransaction,
      // uncomment the line below to enable Spotlight (https://spotlightjs.com)
      // spotlight: process.env.NODE_ENV === 'development',
    });

    // Re-arm queue-driven mailbox backfills. A restart drops the tick chain, and
    // the nightly rsync backup restarts this service, so recovery must not wait
    // for the slower cron backstop. Fire-and-forget: startup must not block on
    // the database or Redis, and any failure is logged and covered by cron.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      import("@/utils/mail/backfill-boot")
        .then(({ resumeRunningBackfills }) => resumeRunningBackfills())
        .catch((error) => {
          logger.error("Failed to re-arm backfills", { error });
        });
    }
  }

  // This is your Sentry.init call from `sentry.edge.config.js|ts`
  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      // Adjust this value in production, or use tracesSampler for greater control
      tracesSampleRate: 0.1,
      // Setting this option to true will print useful information to the console while you're setting up Sentry.
      debug: false,
      // Redact PII/secrets before sending to Sentry (third party).
      beforeSend,
      beforeSendTransaction,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
