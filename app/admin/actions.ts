"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/server";
import {
  cancelOffering,
  closeOffering,
  updateTermWindow,
} from "@/lib/services/admin";
import {
  clearFailedReservations,
  processOpsWritebackBatch,
} from "@/lib/services/enrollment-ops";

// 管理员保存当前学期选课开放期。
export async function updateTermWindowAction(formData: FormData) {
  // 开放期只能由管理员修改。
  const { user } = await requireRole("ADMIN");
  const selectionStartsAt = new Date(String(formData.get("selectionStartsAt")));
  const selectionEndsAt = new Date(String(formData.get("selectionEndsAt")));

  await updateTermWindow({
    adminId: user.id,
    selectionStartsAt,
    selectionEndsAt,
  });
  // 开放期影响学生规则、管理员统计和日志。
  revalidatePath("/admin/window");
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

// 管理员冻结开课班名单。
export async function closeOfferingAction(formData: FormData) {
  // 冻结只改变开课班状态，不删除已有名单。
  const { user } = await requireRole("ADMIN");
  const offeringId = String(formData.get("offeringId") ?? "");

  await closeOffering(user.id, offeringId);
  // 冻结后统计和日志都需要刷新。
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

// 管理员停开开课班。
export async function cancelOfferingAction(formData: FormData) {
  // 停开会把正式和候补登记统一转为移除。
  const { user } = await requireRole("ADMIN");
  const offeringId = String(formData.get("offeringId") ?? "");
  const reason = String(formData.get("reason") ?? "");

  await cancelOffering(user.id, offeringId, reason);
  // 停开影响统计、详情和操作日志。
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

// 管理员手动处理待写回预占。
export async function processOpsWritebackAction() {
  // 运维动作同样要求管理员角色。
  await requireRole("ADMIN");
  await processOpsWritebackBatch();
  // 写回后刷新运维、统计和日志视图。
  revalidatePath("/admin/ops");
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

// 管理员清理失败或悬空的Redis预占记录。
export async function clearFailedReservationsAction() {
  // 该动作不会清理正常预占和已确认预占。
  await requireRole("ADMIN");
  await clearFailedReservations();
  revalidatePath("/admin/ops");
  revalidatePath("/admin/stats");
}
