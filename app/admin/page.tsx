import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/components/logout-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireRole } from "@/lib/auth/server";
import {
  categoryLabel,
  dateTimeLabel,
  datetimeLocalValue,
  offeringStatusLabel,
  registrationStatusLabel,
} from "@/lib/format";
import { getAdminDashboard } from "@/lib/services/admin";
import { MeetingTimeList } from "@/components/student/course-display";
import {
  cancelOfferingAction,
  closeOfferingAction,
  updateTermWindowAction,
} from "@/app/admin/actions";

export const dynamic = "force-dynamic";

type AdminPageProps = {
  searchParams?: Promise<{
    detail?: string;
  }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const params = await searchParams;
  const { user } = await requireRole("ADMIN");
  const dashboard = await getAdminDashboard();
  const selectedOffering = dashboard.offeringDetails.find(
    (offering) => offering.id === params?.detail,
  );

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-500">当前登录：{user.name}</p>
            <h1 className="mt-2 text-2xl font-semibold text-zinc-950">选课管理控制台</h1>
          </div>
          <LogoutButton />
        </header>

        <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>选课开放期</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={updateTermWindowAction} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="selectionStartsAt">开始时间</Label>
                  <Input
                    id="selectionStartsAt"
                    name="selectionStartsAt"
                    type="datetime-local"
                    defaultValue={datetimeLocalValue(dashboard.term.selectionStartsAt)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="selectionEndsAt">结束时间</Label>
                  <Input
                    id="selectionEndsAt"
                    name="selectionEndsAt"
                    type="datetime-local"
                    defaultValue={datetimeLocalValue(dashboard.term.selectionEndsAt)}
                  />
                </div>
                <Button>保存开放期</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>课程维度统计</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>课程</TableHead>
                    <TableHead>类别</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>容量</TableHead>
                    <TableHead>有效</TableHead>
                    <TableHead>候补</TableHead>
                    <TableHead>退课</TableHead>
                    <TableHead>移除</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.stats.map((stat) => (
                    <TableRow key={stat.id}>
                      <TableCell>
                        <div className="font-medium text-zinc-950">
                          {stat.courseNo} {stat.name}
                        </div>
                        <div className="text-xs text-zinc-500">{stat.classNo}班</div>
                      </TableCell>
                      <TableCell>{categoryLabel(stat.category)}</TableCell>
                      <TableCell>
                        <Badge>{offeringStatusLabel(stat.status)}</Badge>
                      </TableCell>
                      <TableCell>{stat.capacity}</TableCell>
                      <TableCell>{stat.active}</TableCell>
                      <TableCell>{stat.waitlisted}</TableCell>
                      <TableCell>{stat.dropped}</TableCell>
                      <TableCell>{stat.removed}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Link
                            className="inline-flex h-8 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                            href={`/admin?detail=${stat.id}`}
                            scroll={false}
                          >
                            详情
                          </Link>
                          <form action={closeOfferingAction}>
                            <input name="offeringId" type="hidden" value={stat.id} />
                            <Button
                              disabled={stat.status !== "PUBLISHED"}
                              size="sm"
                              variant="outline"
                            >
                              关闭
                            </Button>
                          </form>
                          <form action={cancelOfferingAction}>
                            <input name="offeringId" type="hidden" value={stat.id} />
                            <input name="reason" type="hidden" value="管理员取消开课班" />
                            <Button
                              disabled={stat.status === "CANCELED"}
                              size="sm"
                              variant="danger"
                            >
                              取消
                            </Button>
                          </form>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 flex gap-3">
                <a
                  className="inline-flex h-10 items-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800"
                  href="/api/admin/export"
                >
                  导出CSV
                </a>
              </div>
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>操作日志</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>内容</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>{dateTimeLabel(log.createdAt)}</TableCell>
                    <TableCell>{log.type}</TableCell>
                    <TableCell>{log.actorRole}</TableCell>
                    <TableCell>{log.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <AdminOfferingSheet offering={selectedOffering} />
    </main>
  );
}

function AdminOfferingSheet({
  offering,
}: {
  offering?: Awaited<ReturnType<typeof getAdminDashboard>>["offeringDetails"][number];
}) {
  return (
    <Sheet open={Boolean(offering)}>
      <SheetOverlay href="/admin" />
      {offering ? (
        <SheetContent className="max-w-3xl">
          <SheetHeader>
            <div className="flex flex-wrap gap-2">
              <Badge>{categoryLabel(offering.category)}</Badge>
              <Badge variant={offering.status === "PUBLISHED" ? "success" : "warning"}>
                {offeringStatusLabel(offering.status)}
              </Badge>
            </div>
            <SheetTitle>
              {offering.courseNo} {offering.name}
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            <div className="grid gap-3 sm:grid-cols-5">
              <MetricBox label="容量" value={`${offering.enrolledCount}/${offering.capacity}`} />
              <MetricBox label="有效" value={`${offering.active}`} />
              <MetricBox label="候补" value={`${offering.waitlisted}`} />
              <MetricBox label="退课" value={`${offering.dropped}`} />
              <MetricBox label="移除" value={`${offering.removed}`} />
            </div>
            <Progress value={offering.rate} />
            <DetailGrid
              items={[
                ["班号", `${offering.classNo}班`],
                ["教师", offering.teacherName],
                ["选课率", `${offering.rate}%`],
              ]}
            />
            <div>
              <div className="mb-2 text-sm font-medium text-zinc-950">时间</div>
              {offering.meetingTimes.length ? (
                <MeetingTimeList meetingTimes={offering.meetingTimes} />
              ) : (
                <Empty>未排课</Empty>
              )}
            </div>
            <RegistrationTable registrations={offering.registrations} />
            <OfferingLogTable logs={offering.logs} />
          </SheetBody>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function RegistrationTable({
  registrations,
}: {
  registrations: NonNullable<
    Awaited<ReturnType<typeof getAdminDashboard>>["offeringDetails"][number]
  >["registrations"];
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-950">名单</div>
      {registrations.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>学号</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead>专业</TableHead>
              <TableHead>年级</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>顺位</TableHead>
              <TableHead>登记时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {registrations.map((registration) => (
              <TableRow key={registration.id}>
                <TableCell>{registration.student.studentNo}</TableCell>
                <TableCell>{registration.student.name}</TableCell>
                <TableCell>{registration.student.major.name}</TableCell>
                <TableCell>{registration.student.grade}</TableCell>
                <TableCell>
                  <Badge variant={registrationStatusVariant(registration.status)}>
                    {registrationStatusLabel(registration.status)}
                  </Badge>
                </TableCell>
                <TableCell>{registration.waitlistPosition ?? "-"}</TableCell>
                <TableCell>{dateTimeLabel(registration.registeredAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>暂无名单</Empty>
      )}
    </div>
  );
}

function registrationStatusVariant(
  status: Awaited<
    ReturnType<typeof getAdminDashboard>
  >["offeringDetails"][number]["registrations"][number]["status"],
): "secondary" | "success" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "WAITLISTED") return "warning";
  return "secondary";
}

function OfferingLogTable({
  logs,
}: {
  logs: Awaited<ReturnType<typeof getAdminDashboard>>["logs"];
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-950">日志</div>
      {logs.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>内容</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell>{dateTimeLabel(log.createdAt)}</TableCell>
                <TableCell>{log.type}</TableCell>
                <TableCell>{log.actorRole}</TableCell>
                <TableCell>{log.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>暂无日志</Empty>
      )}
    </div>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function DetailGrid({ items }: { items: [string, string][] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map(([label, value]) => (
        <div className="rounded-lg border border-zinc-200 p-3" key={label}>
          <div className="text-xs text-zinc-500">{label}</div>
          {value ? <div className="mt-1 text-sm font-medium text-zinc-950">{value}</div> : null}
        </div>
      ))}
    </div>
  );
}
