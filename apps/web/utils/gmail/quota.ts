import { sleep } from "@/utils/sleep";

/**
 * Gmail quota accounting.
 *
 * Gmail's per-user rate limit is charged in QUOTA UNITS PER MINUTE, not
 * requests, and the cost depends on the method. Since 2026-05-01
 * `messages.get` costs 20 units (it was 5), which makes a naive "list a page,
 * then fetch every message in parallel" crawl four times as expensive as it
 * used to be.
 *
 * The default ceiling is 15,000 units/min/user; projects created on or after
 * 2026-05-01 are capped at 6,000. A fan-out that ignores the budget spends it
 * in a burst, Gmail answers 403 "Quota exceeded for quota metric 'Total Query
 * Cost' and limit 'Units per minute per user'", and the retry wrapper
 * (utils/gmail/retry.ts) backs off 1s-10s and tries the same work again - which
 * spends more units and makes no progress. On a large mailbox that loop never
 * converges.
 *
 * `paceGmailQuota` spreads calls out to the budget instead. Each call reserves
 * a slot on its account's timeline, so concurrent callers end up evenly spaced
 * rather than bursting: 25 parallel gets at 20 units each become one request
 * every 100ms instead of 25 at once.
 */

/** Unit cost of `users.messages.get` since the 2026-05-01 quota change. */
export const GMAIL_UNITS_PER_MESSAGE_GET = 20;
/** Unit cost of `users.messages.list` (unchanged by the 2026-05-01 change). */
export const GMAIL_UNITS_PER_MESSAGE_LIST = 5;

const DEFAULT_UNITS_PER_MINUTE_PER_USER = 15_000;
// Leave headroom for the account's other Gmail traffic (watches, label sync,
// user-triggered reads) so background crawling never starves the UI.
const QUOTA_HEADROOM = 0.8;

/**
 * Per-user unit budget per minute, after headroom.
 *
 * Override with GMAIL_QUOTA_UNITS_PER_MINUTE_PER_USER for projects on the
 * newer 6,000 units/min cap.
 */
export function unitsPerMinuteBudget(): number {
  const override = Number(process.env.GMAIL_QUOTA_UNITS_PER_MINUTE_PER_USER);
  const limit =
    Number.isFinite(override) && override > 0
      ? override
      : DEFAULT_UNITS_PER_MINUTE_PER_USER;
  return limit * QUOTA_HEADROOM;
}

/** Minimum spacing between two requests of the given unit cost. */
export function minIntervalMsForUnits(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return (units / unitsPerMinuteBudget()) * 60_000;
}

// Earliest time the next request for an account may start. Concurrent callers
// push this forward as they reserve slots, which is what turns a parallel
// fan-out into an evenly spaced stream.
const nextAllowedAt = new Map<string, number>();

/**
 * Wait until this account's budget allows one more request of `units` cost.
 *
 * `key` identifies the mailbox (its EmailAccount id). The quota is enforced per
 * Gmail user, so two accounts on one deployment must not share a timeline.
 */
export async function paceGmailQuota(
  key: string,
  units: number,
): Promise<void> {
  const intervalMs = minIntervalMsForUnits(units);
  if (intervalMs <= 0) return;

  const now = Date.now();
  const scheduledAt = Math.max(now, nextAllowedAt.get(key) ?? now);
  nextAllowedAt.set(key, scheduledAt + intervalMs);

  const waitMs = scheduledAt - now;
  if (waitMs > 0) await sleep(waitMs);
}

/** Test seam: forget all pacing state. */
export function resetGmailQuotaPacing(): void {
  nextAllowedAt.clear();
}
