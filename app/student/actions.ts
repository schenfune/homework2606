"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/server";
import {
  dropCourse,
  EnrollmentError,
  joinWaitlist,
  selectCourse,
} from "@/lib/services/enrollment";

export async function selectCourseAction(formData: FormData) {
  const { user } = await requireRole("STUDENT");
  const offeringId = String(formData.get("offeringId") ?? "");

  if (!user.profileId || !offeringId) {
    throw new Error("缺少选课信息");
  }

  try {
    await selectCourse(user.profileId, offeringId);
  } catch (error) {
    if (!(error instanceof EnrollmentError && error.code === "COURSE_FULL")) {
      throw error;
    }
  }

  revalidatePath("/student");
}

export async function joinWaitlistAction(formData: FormData) {
  const { user } = await requireRole("STUDENT");
  const offeringId = String(formData.get("offeringId") ?? "");

  if (!user.profileId || !offeringId) {
    throw new Error("缺少候补信息");
  }

  await joinWaitlist(user.profileId, offeringId);
  revalidatePath("/student");
}

export async function dropCourseAction(formData: FormData) {
  const { user } = await requireRole("STUDENT");
  const registrationId = String(formData.get("registrationId") ?? "");

  if (!user.profileId || !registrationId) {
    throw new Error("缺少退课信息");
  }

  await dropCourse(user.profileId, registrationId);
  revalidatePath("/student");
}
