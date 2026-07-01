import {
  CourseCategory,
  OfferingStatus,
  OperationType,
  RegistrationStatus,
  Role,
} from "@prisma/client";

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
    CLOSED: "名单冻结",
    CANCELED: "停开",
  }[status];
}

export function registrationStatusLabel(status: RegistrationStatus) {
  return {
    ACTIVE: "已选",
    WAITLISTED: "候补中",
    DROPPED: "已退课",
    REMOVED: "停开移除",
  }[status];
}

export function operationTypeLabel(type: OperationType) {
  return {
    COURSE_SELECTED: "学生选课",
    COURSE_WAITLISTED: "加入候补",
    COURSE_DROPPED: "学生退课",
    WAITLIST_PROMOTED: "候补转入",
    WAITLIST_DROPPED: "退出候补",
    OFFERING_CLOSED: "冻结名单",
    OFFERING_CANCELED: "停开课程",
    TERM_WINDOW_UPDATED: "调整选课时间",
    RESULT_EXPORTED: "导出名单",
    RESULT_API_ACCESSED: "查询名单接口",
  }[type];
}

export function roleLabel(role: Role) {
  return {
    STUDENT: "学生",
    ADMIN: "管理员",
  }[role];
}

export function dateTimeLabel(date: Date | string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function datetimeLocalValue(date: Date | string) {
  const value = new Date(date);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
