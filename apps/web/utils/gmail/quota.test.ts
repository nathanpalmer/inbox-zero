import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "@/utils/sleep";
import {
  GMAIL_UNITS_PER_MESSAGE_GET,
  GMAIL_UNITS_PER_MESSAGE_LIST,
  minIntervalMsForUnits,
  paceGmailQuota,
  resetGmailQuotaPacing,
} from "./quota";

vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

describe("paceGmailQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGmailQuotaPacing();
  });

  afterEach(() => {
    delete process.env.GMAIL_QUOTA_UNITS_PER_MINUTE_PER_USER;
    resetGmailQuotaPacing();
  });

  it("does not delay the first request for an account", async () => {
    await paceGmailQuota("account-first", GMAIL_UNITS_PER_MESSAGE_GET);

    expect(sleep).not.toHaveBeenCalled();
  });

  it("spaces sequential requests by the method's unit cost", async () => {
    // 20 units against 15,000 x 0.8 = 12,000 units/min => 100ms.
    await paceGmailQuota("account-sequential", GMAIL_UNITS_PER_MESSAGE_GET);
    await paceGmailQuota("account-sequential", GMAIL_UNITS_PER_MESSAGE_GET);

    expect(minIntervalMsForUnits(GMAIL_UNITS_PER_MESSAGE_GET)).toBe(100);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("spreads a parallel fan-out into reserved slots", async () => {
    // The shape that caused the overflow: many gets issued at once.
    await Promise.all([
      paceGmailQuota("account-fanout", GMAIL_UNITS_PER_MESSAGE_GET),
      paceGmailQuota("account-fanout", GMAIL_UNITS_PER_MESSAGE_GET),
      paceGmailQuota("account-fanout", GMAIL_UNITS_PER_MESSAGE_GET),
    ]);

    // Slot 0 goes immediately; the rest wait 100ms and 200ms behind it.
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("prices a cheaper method proportionally", async () => {
    // 5 units => 25ms.
    await paceGmailQuota("account-list", GMAIL_UNITS_PER_MESSAGE_LIST);
    await paceGmailQuota("account-list", GMAIL_UNITS_PER_MESSAGE_LIST);

    expect(minIntervalMsForUnits(GMAIL_UNITS_PER_MESSAGE_LIST)).toBe(25);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("honours the units-per-minute override", async () => {
    // A project on the 2026-05-01 cap of 6,000 units/min/user.
    process.env.GMAIL_QUOTA_UNITS_PER_MINUTE_PER_USER = "6000";

    await paceGmailQuota("account-override", GMAIL_UNITS_PER_MESSAGE_GET);
    await paceGmailQuota("account-override", GMAIL_UNITS_PER_MESSAGE_GET);

    // 20 / (6,000 x 0.8) of a minute = 250ms.
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("keeps one account's budget separate from another's", async () => {
    await paceGmailQuota("account-busy", GMAIL_UNITS_PER_MESSAGE_GET);
    await paceGmailQuota("account-busy", GMAIL_UNITS_PER_MESSAGE_GET);
    vi.mocked(sleep).mockClear();

    // A different mailbox must not inherit the first one's timeline.
    await paceGmailQuota("account-idle", GMAIL_UNITS_PER_MESSAGE_GET);

    expect(sleep).not.toHaveBeenCalled();
  });
});
