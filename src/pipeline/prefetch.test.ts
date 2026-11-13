import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../scheduling/availability.js", () => ({ checkAvailability: vi.fn() }));
const { extractDate } = await import("./prefetch.js");

afterEach(() => vi.useRealTimers());

describe("extractDate", () => {
  it("rolls a past month/day into next year", () => {
    vi.useFakeTimers({ now: new Date("2026-12-20T15:00:00Z") });
    expect(extractDate("can I come on 5th jan", "America/New_York")).toBe("2027-01-05");
    expect(extractDate("december 22 please", "America/New_York")).toBe("2026-12-22");
  });

  it("uses the practice timezone, not UTC", () => {
    // 20:00 UTC on Apr 2 is already Apr 3 in India; "april 2" has passed there.
    vi.useFakeTimers({ now: new Date("2026-04-02T20:00:00Z") });
    expect(extractDate("tomorrow", "Asia/Kolkata")).toBe("2026-04-04");
    expect(extractDate("april 3rd", "Asia/Kolkata")).toBe("2026-04-03");
    expect(extractDate("april 2", "Asia/Kolkata")).toBe("2027-04-02");
  });

  it("rejects impossible dates", () => {
    vi.useFakeTimers({ now: new Date("2026-01-10T12:00:00Z") });
    expect(extractDate("31st feb", "America/New_York")).toBeNull();
  });
});
