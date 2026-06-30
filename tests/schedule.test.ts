import { describe, expect, it } from "vitest";
import { formatMeetingTime, hasMeetingConflict, rangesOverlap } from "@/lib/services/schedule";

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

  it("detects inclusive range overlap boundaries", () => {
    expect(rangesOverlap(1, 2, 2, 4)).toBe(true);
    expect(rangesOverlap(1, 2, 3, 4)).toBe(false);
  });

  it("formats known and fallback weekdays", () => {
    expect(
      formatMeetingTime({
        weekday: 5,
        startPeriod: 9,
        endPeriod: 10,
        startWeek: 1,
        endWeek: 16,
      }),
    ).toBe("周五 第9-10节 第1-16周");
    expect(
      formatMeetingTime({
        weekday: 8,
        startPeriod: 1,
        endPeriod: 2,
        startWeek: 3,
        endWeek: 4,
      }),
    ).toBe("周8 第1-2节 第3-4周");
  });
});
