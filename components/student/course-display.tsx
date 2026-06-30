import Link from "next/link";
import { CourseCategory, OfferingStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip } from "@/components/ui/tooltip";
import { categoryLabel, offeringStatusLabel } from "@/lib/format";
import type { CourseRuleCheck } from "@/lib/services/enrollment";
import { formatMeetingTime, type MeetingSlot } from "@/lib/services/schedule";
import { joinWaitlistAction, selectCourseAction } from "@/app/student/actions";

export type CourseListItem = {
  id: string;
  courseNo: string;
  name: string;
  classNo: string;
  category: CourseCategory;
  credits: number;
  teacherName: string;
  capacity: number;
  enrolledCount: number;
  status: OfferingStatus;
  meetingTimes: MeetingSlot[];
  ruleChecks: CourseRuleCheck[];
  unavailableReasons: string[];
  selected: boolean;
  waitlisted: boolean;
  waitlistPosition?: number | null;
};

export function CourseStatusBadges({ course }: { course: CourseListItem }) {
  const labels = getBlockLabels(course);

  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge>{categoryLabel(course.category)}</Badge>
      <Badge variant={course.status === "PUBLISHED" ? "success" : "warning"}>
        {offeringStatusLabel(course.status)}
      </Badge>
      {labels.map((label) => (
        <Badge key={label} variant="warning">
          {label}
        </Badge>
      ))}
    </div>
  );
}

export function CourseAction({ course }: { course: CourseListItem }) {
  const disabled = course.unavailableReasons.length > 0;
  const waitlistAction = isFull(course) && !disabled && !course.selected && !course.waitlisted;
  const action = waitlistAction ? joinWaitlistAction : selectCourseAction;
  const label = course.selected
    ? "已在课表"
    : course.waitlisted
    ? "候补中"
    : isFull(course) && !disabled
    ? "候补"
    : "选课";

  return (
    <Tooltip content={disabled ? getTooltipContent(course) : undefined}>
      <form action={action}>
        <input name="offeringId" type="hidden" value={course.id} />
        <Button disabled={disabled} size="sm">
          {label}
        </Button>
      </form>
    </Tooltip>
  );
}

export function CapacityMeter({
  enrolledCount,
  capacity,
}: {
  enrolledCount: number;
  capacity: number;
}) {
  const value = capacity === 0 ? 0 : Math.round((enrolledCount / capacity) * 100);

  return (
    <div className="min-w-28 space-y-1">
      <div className="text-xs font-medium text-zinc-600">
        {enrolledCount}/{capacity}
      </div>
      <Progress value={value} />
    </div>
  );
}

export function MeetingTimeList({ meetingTimes }: { meetingTimes: MeetingSlot[] }) {
  return (
    <div className="space-y-1">
      {meetingTimes.map((slot) => (
        <div
          className="whitespace-nowrap text-xs text-zinc-500"
          key={`${slot.weekday}-${slot.startPeriod}-${slot.endPeriod}-${slot.startWeek}-${slot.endWeek}`}
        >
          {formatMeetingTime(slot)}
        </div>
      ))}
    </div>
  );
}

export function CourseDetailLink({ courseId, tab }: { courseId: string; tab: string }) {
  return (
    <Link
      className="text-sm font-medium text-zinc-700 hover:text-zinc-950"
      href={`/student?tab=${tab}&detail=${courseId}`}
      scroll={false}
    >
      详情
    </Link>
  );
}

export function getTooltipContent(course: CourseListItem) {
  return getBlockLabels(course).join(" / ");
}

function getBlockLabels(course: CourseListItem) {
  const labels: string[] = course.unavailableReasons.map(reasonToLabel);

  if (course.selected && !labels.includes("已在课表")) {
    labels.unshift("已在课表");
  }

  if (course.waitlisted && !labels.includes("候补中")) {
    labels.unshift("候补中");
  }

  return Array.from(new Set(labels));
}

function reasonToLabel(reason: string) {
  if (reason.includes("必修")) return "必修";
  if (reason.includes("已选择")) return "已在课表";
  if (reason.includes("候补")) return "候补中";
  if (reason.includes("开放期")) return "未开放";
  if (reason.includes("冻结")) return "名单冻结";
  if (reason.includes("停开")) return "停开";
  if (reason.includes("容量")) return "名额满";
  if (reason.includes("专业")) return "不适合";
  if (reason.includes("冲突")) return "冲突";
  return "不能选";
}

function isFull(course: CourseListItem) {
  return course.enrolledCount >= course.capacity;
}
