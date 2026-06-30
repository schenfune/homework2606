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

export async function updateTermWindowAction(formData: FormData) {
  const { user } = await requireRole("ADMIN");
  const selectionStartsAt = new Date(String(formData.get("selectionStartsAt")));
  const selectionEndsAt = new Date(String(formData.get("selectionEndsAt")));

  await updateTermWindow({
    adminId: user.id,
    selectionStartsAt,
    selectionEndsAt,
  });
  revalidatePath("/admin/window");
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

export async function closeOfferingAction(formData: FormData) {
  const { user } = await requireRole("ADMIN");
  const offeringId = String(formData.get("offeringId") ?? "");

  await closeOffering(user.id, offeringId);
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

export async function cancelOfferingAction(formData: FormData) {
  const { user } = await requireRole("ADMIN");
  const offeringId = String(formData.get("offeringId") ?? "");
  const reason = String(formData.get("reason") ?? "");

  await cancelOffering(user.id, offeringId, reason);
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

export async function processOpsWritebackAction() {
  await requireRole("ADMIN");
  await processOpsWritebackBatch();
  revalidatePath("/admin/ops");
  revalidatePath("/admin/stats");
  revalidatePath("/admin/logs");
}

export async function clearFailedReservationsAction() {
  await requireRole("ADMIN");
  await clearFailedReservations();
  revalidatePath("/admin/ops");
  revalidatePath("/admin/stats");
}
