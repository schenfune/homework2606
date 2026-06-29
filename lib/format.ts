import { CourseCategory, OfferingStatus, RegistrationStatus } from "@prisma/client";

export function categoryLabel(category: CourseCategory) {
  return {
    REQUIRED: "必修课",
    MAJOR_ELECTIVE: "专业选修",
    PUBLIC_ELECTIVE: "公选课",
  }[category];
}

export function offeringStatusLabel(status: OfferingStatus) {
  return {
    PUBLISHED: "开放",
    CLOSED: "已冻结",
    CANCELED: "已停开",
  }[status];
}

export function registrationStatusLabel(status: RegistrationStatus) {
  return {
    ACTIVE: "有效",
    WAITLISTED: "候补",
    DROPPED: "已退课",
    REMOVED: "已移除",
  }[status];
}

export function dateTimeLabel(date: Date | string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function datetimeLocalValue(date: Date | string) {
  const value = new Date(date);
  const offset = value.getTimezoneOffset();
  const local = new Date(value.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}
