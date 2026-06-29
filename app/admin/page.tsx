import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/components/logout-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "@/lib/format";
import { getAdminDashboard } from "@/lib/services/admin";
import {
  cancelOfferingAction,
  closeOfferingAction,
  updateTermWindowAction,
} from "@/app/admin/actions";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { user } = await requireRole("ADMIN");
  const dashboard = await getAdminDashboard();

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
                      <TableCell>{stat.dropped}</TableCell>
                      <TableCell>{stat.removed}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
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
    </main>
  );
}
