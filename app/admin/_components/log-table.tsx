import { Empty } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateTimeLabel } from "@/lib/format";
import type { getAdminDashboard } from "@/lib/services/admin";

type LogTableProps = {
  logs: Awaited<ReturnType<typeof getAdminDashboard>>["logs"];
};

export function LogTable({ logs }: LogTableProps) {
  return logs.length ? (
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
  );
}
