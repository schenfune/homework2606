import { CourseCategory, OfferingStatus, RegistrationStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { LogoutButton } from "@/components/logout-button";
import {
  CapacityMeter,
  CourseAction,
  CourseDetailLink,
  CourseStatusBadges,
  getTooltipContent,
  MeetingTimeList,
  type CourseListItem,
} from "@/components/student/course-display";
import { requireRole } from "@/lib/auth/server";
import {
  categoryLabel,
  dateTimeLabel,
  offeringStatusLabel,
  registrationStatusLabel,
} from "@/lib/format";
import { getStudentDashboard } from "@/lib/services/enrollment";
import { dropCourseAction } from "@/app/student/actions";

export const dynamic = "force-dynamic";

type StudentPageProps = {
  searchParams?: Promise<{
    tab?: string;
    detail?: string;
  }>;
};

export default async function StudentPage({ searchParams }: StudentPageProps) {
  const params = await searchParams;
  const currentTab = params?.tab === "schedule" ? "schedule" : "courses";
  const detailId = params?.detail;
  const { user } = await requireRole("STUDENT");

  if (!user.profileId) {
    throw new Error("学生档案不存在");
  }

  const dashboard = await getStudentDashboard(user.profileId);
  const selectedCourse = dashboard.courses.find((course) => course.id === detailId);

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm text-zinc-500">
              {dashboard.term.name} · {dateTimeLabel(dashboard.term.selectionStartsAt)} -{" "}
              {dateTimeLabel(dashboard.term.selectionEndsAt)}
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-zinc-950">
              {dashboard.student.name}的选课中心
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SummaryBox label="专业" value={dashboard.student.major.name} />
            <SummaryBox label="年级" value={`${dashboard.student.grade}级`} />
            <SummaryBox label="学分" value={`${dashboard.totalCredits}`} />
            <LogoutButton />
          </div>
        </header>

        <Tabs>
          <TabsList>
            <TabsTrigger active={currentTab === "courses"} href="/student?tab=courses">
              选课
            </TabsTrigger>
            <TabsTrigger active={currentTab === "schedule"} href="/student?tab=schedule">
              课表
            </TabsTrigger>
          </TabsList>

          {currentTab === "courses" ? (
            <TabsContent>
              <Card>
                <CardHeader>
                  <CardTitle>当前学期课程</CardTitle>
                </CardHeader>
                <CardContent>
                  {dashboard.courses.length > 0 ? (
                    <CourseTable courses={dashboard.courses} tab={currentTab} />
                  ) : (
                    <Empty>暂无课程</Empty>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          ) : (
            <TabsContent>
              <Card>
                <CardHeader>
                  <CardTitle>我的课表</CardTitle>
                </CardHeader>
                <CardContent>
                  {dashboard.registrations.length > 0 ? (
                    <div className="space-y-6">
                      <ScheduleGrid registrations={dashboard.registrations} />
                      <ScheduleTable registrations={dashboard.registrations} />
                    </div>
                  ) : (
                    <Empty>暂无课表</Empty>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>

      <CourseSheet course={selectedCourse} tab={currentTab} />
    </main>
  );
}

function CourseTable({ courses, tab }: { courses: CourseListItem[]; tab: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>课程</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>时间</TableHead>
          <TableHead>名额</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {courses.map((course) => (
          <TableRow key={course.id}>
            <TableCell>
              <div className="font-medium text-zinc-950">
                {course.courseNo} {course.name}
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {course.classNo}班 · {course.teacherName} · {course.credits}学分
              </div>
            </TableCell>
            <TableCell>
              <CourseStatusBadges course={course} />
            </TableCell>
            <TableCell>
              <MeetingTimeList meetingTimes={course.meetingTimes} />
            </TableCell>
            <TableCell>
              <CapacityMeter
                capacity={course.capacity}
                enrolledCount={course.enrolledCount}
              />
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-3">
                <CourseDetailLink courseId={course.id} tab={tab} />
                <CourseAction course={course} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type ScheduleRegistration = Awaited<
  ReturnType<typeof getStudentDashboard>
>["registrations"][number];

function ScheduleGrid({ registrations }: { registrations: ScheduleRegistration[] }) {
  const visibleRegistrations = registrations.filter((registration) =>
    isScheduleOccupyingStatus(registration.status),
  );
  const maxPeriod = Math.max(
    8,
    ...visibleRegistrations.flatMap((registration) =>
      registration.offering.meetingTimes.map((slot) => slot.endPeriod),
    ),
  );
  const periods = Array.from({ length: maxPeriod }, (_, index) => index + 1);

  return (
    <div>
      <div className="mb-3 text-sm font-medium text-zinc-950">周课表</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">节次</TableHead>
            {weekdays.map((weekday) => (
              <TableHead key={weekday.value}>{weekday.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.map((period) => (
            <TableRow key={period}>
              <TableCell className="font-medium text-zinc-950">{period}</TableCell>
              {weekdays.map((weekday) => {
                const cells = getScheduleCells({
                  registrations: visibleRegistrations,
                  weekday: weekday.value,
                  period,
                });

                return (
                  <TableCell className="min-w-32 align-top" key={weekday.value}>
                    {cells.length > 0 ? (
                      <div className="space-y-2">
                        {cells.map((cell) => (
                          <div
                            className="rounded-md border border-zinc-200 bg-white p-2"
                            key={cell.key}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-medium text-zinc-950">
                                {cell.courseName}
                              </div>
                              <Badge
                                variant={cell.status === "WAITLISTED" ? "warning" : "success"}
                              >
                                {cell.status === "WAITLISTED" ? "候补" : "已选"}
                              </Badge>
                            </div>
                            <div className="mt-1 text-xs text-zinc-500">
                              {cell.classNo}班 · {cell.weeks}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-300">-</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function getScheduleCells({
  registrations,
  weekday,
  period,
}: {
  registrations: ScheduleRegistration[];
  weekday: number;
  period: number;
}) {
  return registrations.flatMap((registration) =>
    registration.offering.meetingTimes
      .filter(
        (slot) =>
          slot.weekday === weekday &&
          period >= slot.startPeriod &&
          period <= slot.endPeriod,
      )
      .map((slot) => ({
        key: `${registration.id}-${slot.id}-${period}`,
        courseName: registration.offering.course.name,
        classNo: registration.offering.classNo,
        weeks: `${slot.startWeek}-${slot.endWeek}周`,
        status: String(registration.status),
      })),
  );
}

function isScheduleOccupyingStatus(status: unknown) {
  return status === "ACTIVE" || status === "WAITLISTED";
}

const weekdays = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
];

function ScheduleTable({
  registrations,
}: {
  registrations: ScheduleRegistration[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>课程</TableHead>
          <TableHead>类别</TableHead>
          <TableHead>时间</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {registrations.map((registration) => {
          const course = registration.offering.course;
          const canDrop =
            course.category !== CourseCategory.REQUIRED &&
            registration.offering.status === OfferingStatus.PUBLISHED;
          const lockLabel = course.category === CourseCategory.REQUIRED ? "必修" : "冻结";
          const actionLabel =
            registration.status === RegistrationStatus.WAITLISTED ? "退出候补" : "退课";

          return (
            <TableRow key={registration.id}>
              <TableCell>
                <div className="font-medium text-zinc-950">{course.name}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {registration.offering.classNo}班 · {course.credits}学分
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{categoryLabel(course.category)}</Badge>
                  {registration.status === RegistrationStatus.WAITLISTED ? (
                    <Badge variant="warning">{registrationStatusLabel(registration.status)}</Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <MeetingTimeList meetingTimes={registration.offering.meetingTimes} />
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  {canDrop ? (
                    <form action={dropCourseAction}>
                      <input name="registrationId" type="hidden" value={registration.id} />
                      <Button size="sm" variant="outline">
                        {actionLabel}
                      </Button>
                    </form>
                  ) : (
                    <Tooltip content={lockLabel}>
                      <Button disabled size="sm" variant="outline">
                        {lockLabel}
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CourseSheet({
  course,
  tab,
}: {
  course?: CourseListItem;
  tab: string;
}) {
  return (
    <Sheet open={Boolean(course)}>
      <SheetOverlay href={`/student?tab=${tab}`} />
      {course ? (
        <SheetContent>
          <SheetHeader>
            <div className="flex flex-wrap gap-2">
              <Badge>{categoryLabel(course.category)}</Badge>
              <Badge variant={course.status === "PUBLISHED" ? "success" : "warning"}>
                {offeringStatusLabel(course.status)}
              </Badge>
            </div>
            <SheetTitle>
              {course.courseNo} {course.name}
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            <DetailGrid
              items={[
                ["班号", `${course.classNo}班`],
                ["教师", course.teacherName],
                ["学分", `${course.credits}`],
                ["已选/名额", `${course.enrolledCount}/${course.capacity}`],
              ]}
            />
            <div>
              <div className="mb-2 text-sm font-medium text-zinc-950">时间</div>
              <MeetingTimeList meetingTimes={course.meetingTimes} />
            </div>
            <RuleCheckTable checks={course.ruleChecks} />
            <div className="flex items-center justify-between rounded-lg border border-zinc-200 p-3">
              <CourseStatusBadges course={course} />
              <Tooltip content={course.unavailableReasons.length ? getTooltipContent(course) : undefined}>
                <span className="text-sm text-zinc-500">
                  {availabilityLabel(course)}
                </span>
              </Tooltip>
            </div>
          </SheetBody>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function availabilityLabel(course: CourseListItem) {
  if (course.selected) return "已在课表";
  if (course.waitlisted) return "候补中";
  if (course.unavailableReasons.length) return "不能选";
  if (course.enrolledCount >= course.capacity) return "可候补";
  return "可以选";
}

function RuleCheckTable({ checks }: { checks: CourseListItem["ruleChecks"] }) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-950">选课检查</div>
      <Table>
        <TableBody>
          {checks.map((check) => (
            <TableRow key={check.code}>
              <TableCell className="w-24 text-xs text-zinc-500">{check.label}</TableCell>
              <TableCell>
                <Badge variant={ruleCheckVariant(check.status)}>
                  {ruleCheckStatusLabel(check)}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-xs text-zinc-500">
                {check.detail}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ruleCheckVariant(status: CourseListItem["ruleChecks"][number]["status"]) {
  if (status === "pass") return "success";
  if (status === "block") return "warning";
  return "secondary";
}

function ruleCheckStatusLabel(check: CourseListItem["ruleChecks"][number]) {
  if (check.detail.includes("已在课表")) return "已选";
  if (check.detail.includes("候补中")) return "候补";
  if (check.detail.includes("已满")) return "已满";
  if (check.status === "pass") return "可以";
  if (check.status === "block") return "不能";
  return "注意";
}

function DetailGrid({ items }: { items: [string, string][] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map(([label, value]) => (
        <div className="rounded-lg border border-zinc-200 p-3" key={label}>
          <div className="text-xs text-zinc-500">{label}</div>
          <div className="mt-1 text-sm font-medium text-zinc-950">{value}</div>
        </div>
      ))}
    </div>
  );
}

function SummaryBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}
