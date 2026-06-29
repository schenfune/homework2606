import { CourseCategory, OfferingStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoutButton } from "@/components/logout-button";
import { requireRole } from "@/lib/auth/server";
import { categoryLabel, dateTimeLabel, offeringStatusLabel } from "@/lib/format";
import { getStudentDashboard } from "@/lib/services/enrollment";
import { formatMeetingTime } from "@/lib/services/schedule";
import { dropCourseAction, selectCourseAction } from "@/app/student/actions";

export const dynamic = "force-dynamic";

export default async function StudentPage() {
  const { user } = await requireRole("STUDENT");

  if (!user.profileId) {
    throw new Error("学生档案不存在");
  }

  const dashboard = await getStudentDashboard(user.profileId);

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-sm text-zinc-500">
              {dashboard.term.name} · 选课开放期 {dateTimeLabel(dashboard.term.selectionStartsAt)} 至{" "}
              {dateTimeLabel(dashboard.term.selectionEndsAt)}
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-zinc-950">
              {dashboard.student.name}的选课中心
            </h1>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <SummaryBox label="专业" value={dashboard.student.major.name} />
            <SummaryBox label="年级" value={`${dashboard.student.grade}级`} />
            <SummaryBox label="已登记学分" value={`${dashboard.totalCredits}`} />
          </div>
          <LogoutButton />
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>当前学期课程</CardTitle>
              <CardDescription>必修课由教务系统预置，学生可选择专业选修和公选课</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {dashboard.courses.map((course) => {
                  const disabled = course.unavailableReasons.length > 0;

                  return (
                    <div
                      className="rounded-lg border border-zinc-200 p-4"
                      key={course.id}
                    >
                      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-base font-semibold text-zinc-950">
                              {course.courseNo} {course.name}
                            </h2>
                            <Badge>{categoryLabel(course.category)}</Badge>
                            <Badge variant={course.status === "PUBLISHED" ? "success" : "warning"}>
                              {offeringStatusLabel(course.status)}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm text-zinc-500">
                            {course.classNo}班 · {course.teacherName} · {course.credits}学分 ·{" "}
                            {course.enrolledCount}/{course.capacity}人
                          </p>
                          <p className="mt-2 text-sm text-zinc-600">
                            {course.meetingTimes.map(formatMeetingTime).join("；")}
                          </p>
                          {disabled ? (
                            <p className="mt-2 text-sm text-amber-700">
                              {course.unavailableReasons.join("，")}
                            </p>
                          ) : null}
                        </div>
                        <form action={selectCourseAction}>
                          <input name="offeringId" type="hidden" value={course.id} />
                          <Button disabled={disabled}>
                            {course.selected ? "已选" : "选课"}
                          </Button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>我的课表</CardTitle>
              <CardDescription>必修课和已选课程共同参与时间冲突检测</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {dashboard.registrations.map((registration) => {
                  const course = registration.offering.course;
                  const canDrop =
                    course.category !== CourseCategory.REQUIRED &&
                    registration.offering.status === OfferingStatus.PUBLISHED;

                  return (
                    <div
                      className="rounded-lg border border-zinc-200 p-3"
                      key={registration.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-zinc-950">{course.name}</div>
                          <div className="mt-1 text-xs leading-5 text-zinc-500">
                            {categoryLabel(course.category)} · {registration.offering.classNo}班
                            <br />
                            {registration.offering.meetingTimes.map(formatMeetingTime).join("；")}
                          </div>
                        </div>
                        {canDrop ? (
                          <form action={dropCourseAction}>
                            <input
                              name="registrationId"
                              type="hidden"
                              value={registration.id}
                            />
                            <Button size="sm" variant="outline">
                              退课
                            </Button>
                          </form>
                        ) : (
                          <Badge>{course.category === "REQUIRED" ? "不可退" : "冻结"}</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
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
