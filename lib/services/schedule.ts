export type MeetingSlot = {
  weekday: number;
  startPeriod: number;
  endPeriod: number;
  startWeek: number;
  endWeek: number;
};

// 判断两组上课时间是否存在星期、节次和周次同时重叠。
export function hasMeetingConflict(left: MeetingSlot[], right: MeetingSlot[]) {
  // 任意一对时间片重叠，就说明两门课不能同时进入课表。
  return left.some((a) =>
    right.some(
      (b) =>
        a.weekday === b.weekday &&
        rangesOverlap(a.startPeriod, a.endPeriod, b.startPeriod, b.endPeriod) &&
        rangesOverlap(a.startWeek, a.endWeek, b.startWeek, b.endWeek),
    ),
  );
}

// 判断两个闭区间是否存在交集。
export function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  // 闭区间重叠判断，适用于节次范围和周次范围。
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

// 把数据库中的时间片转换成页面可读的上课时间。
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
