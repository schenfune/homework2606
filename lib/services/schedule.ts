export type MeetingSlot = {
  weekday: number;
  startPeriod: number;
  endPeriod: number;
  startWeek: number;
  endWeek: number;
};

export function hasMeetingConflict(left: MeetingSlot[], right: MeetingSlot[]) {
  return left.some((a) =>
    right.some(
      (b) =>
        a.weekday === b.weekday &&
        rangesOverlap(a.startPeriod, a.endPeriod, b.startPeriod, b.endPeriod) &&
        rangesOverlap(a.startWeek, a.endWeek, b.startWeek, b.endWeek),
    ),
  );
}

export function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function formatMeetingTime(slot: MeetingSlot) {
  return `周${weekdayNames[slot.weekday] ?? slot.weekday} 第${slot.startPeriod}-${slot.endPeriod}节 第${slot.startWeek}-${slot.endWeek}周`;
}

const weekdayNames: Record<number, string> = {
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
  6: "六",
  7: "日",
};
