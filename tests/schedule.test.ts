import { describe, expect, it } from "vitest";
import { hasMeetingConflict } from "@/lib/services/schedule";

describe("hasMeetingConflict", () => {
  it("detects overlapping weekday, periods, and weeks", () => {
    expect(
      hasMeetingConflict(
        [{ weekday: 1, startPeriod: 1, endPeriod: 2, startWeek: 1, endWeek: 16 }],
        [{ weekday: 1, startPeriod: 2, endPeriod: 3, startWeek: 8, endWeek: 12 }],
      ),
    ).toBe(true);
  });

  it("allows same periods on different weekdays", () => {
    expect(
      hasMeetingConflict(
        [{ weekday: 1, startPeriod: 1, endPeriod: 2, startWeek: 1, endWeek: 16 }],
        [{ weekday: 2, startPeriod: 1, endPeriod: 2, startWeek: 1, endWeek: 16 }],
      ),
    ).toBe(false);
  });

  it("allows same periods when teaching weeks do not overlap", () => {
    expect(
      hasMeetingConflict(
        [{ weekday: 1, startPeriod: 1, endPeriod: 2, startWeek: 1, endWeek: 8 }],
        [{ weekday: 1, startPeriod: 1, endPeriod: 2, startWeek: 9, endWeek: 16 }],
      ),
    ).toBe(false);
  });
});
