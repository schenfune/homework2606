"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/server";
import {
  dropCourse,
  EnrollmentError,
  joinWaitlist,
  selectCourse,
} from "@/lib/services/enrollment";

// 学生页面表单提交的正式选课动作。
export async function selectCourseAction(formData: FormData) {
  // Server Action必须再次校验角色，不能信任页面来源。
  const { user } = await requireRole("STUDENT");
  const offeringId = String(formData.get("offeringId") ?? "");

  if (!user.profileId || !offeringId) {
    throw new Error("缺少选课信息");
  }

  try {
    // 满员不是页面异常，捕获后让页面刷新为候补入口。
    await selectCourse(user.profileId, offeringId);
  } catch (error) {
    if (!(error instanceof EnrollmentError && error.code === "COURSE_FULL")) {
      throw error;
    }
  }

  revalidatePath("/student");
}

// 学生页面表单提交的加入候补动作。
export async function joinWaitlistAction(formData: FormData) {
  // 候补动作只能由学生本人触发。
  const { user } = await requireRole("STUDENT");
  const offeringId = String(formData.get("offeringId") ?? "");

  if (!user.profileId || !offeringId) {
    throw new Error("缺少候补信息");
  }

  await joinWaitlist(user.profileId, offeringId);
  // 刷新学生页，使候补状态和课表立即更新。
  revalidatePath("/student");
}

// 学生页面表单提交的退课或退出候补动作。
export async function dropCourseAction(formData: FormData) {
  // registrationId可以是数据库登记ID，也可以是Redis临时预占ID。
  const { user } = await requireRole("STUDENT");
  const registrationId = String(formData.get("registrationId") ?? "");

  if (!user.profileId || !registrationId) {
    throw new Error("缺少退课信息");
  }

  await dropCourse(user.profileId, registrationId);
  // 退课后需要刷新课程列表、课表和按钮状态。
  revalidatePath("/student");
}
