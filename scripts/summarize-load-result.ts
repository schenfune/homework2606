import { RegistrationStatus } from "@prisma/client";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prisma } from "../lib/db/prisma";
import { redis } from "../lib/db/redis";
import { getRedisGateSnapshot } from "../lib/services/enrollment-reservations";

const artifactDir = "artifacts";
const targetPath = `${artifactDir}/load-test-target.json`;
const k6SummaryPath = `${artifactDir}/k6-enrollment-summary.json`;
const verificationJsonPath = `${artifactDir}/load-test-verification.json`;
const verificationMarkdownPath = `${artifactDir}/load-test-verification.md`;

type K6Summary = {
  metrics?: Record<string, { values?: Record<string, number> }>;
};

type LoadTarget = {
  offeringId?: string;
  courseNo?: string;
  classNo?: string;
};

type LoadVerificationReport = {
  generatedAt: string;
  target: {
    offeringId: string;
    courseNo: string;
    courseName: string;
    classNo: string;
    term: string;
    capacity: number;
    enrolledCount: number;
  };
  registrations: {
    active: number;
    waitlisted: number;
    dropped: number;
    removed: number;
  };
  redis: {
    activeReserved: number;
    waitlistSequence: number;
  };
  consistency: {
    activeNotGreaterThanCapacity: boolean;
    enrolledCounterMatchesActive: boolean;
    passed: boolean;
  };
  k6: {
    totalRequests: number;
    p95DurationMs: number;
    activeResponses: number;
    waitlistedResponses: number;
    successResponses: number;
    unknownSuccessResponses: number;
    businessRejects: number;
    courseFullResponses: number;
    busyRejects: number;
    duplicateRejects: number;
    conflictRejects: number;
    ruleRejects: number;
    otherBusinessRejects: number;
    rateLimitedResponses: number;
    authRejects: number;
    serverErrors: number;
    handledOutcomeRate: number;
  };
};

async function main() {
  await mkdir(artifactDir, { recursive: true });

  const target = await readLoadTarget();
  const offeringId = process.env.LOAD_OFFERING_ID || target?.offeringId;
  const courseNo = process.env.LOAD_COURSE_NO || target?.courseNo || "LT101";
  const classNo = process.env.LOAD_CLASS_NO || target?.classNo || "LT";
  const offering = await resolveLoadOffering({ offeringId, courseNo, classNo });
  const grouped = await prisma.courseRegistration.groupBy({
    by: ["status"],
    where: {
      offeringId: offering.id,
    },
    _count: {
      _all: true,
    },
  });
  const counts = Object.fromEntries(
    Object.values(RegistrationStatus).map((status) => [status, 0]),
  ) as Record<RegistrationStatus, number>;

  for (const item of grouped) {
    counts[item.status] = item._count._all;
  }

  const activeCount = counts.ACTIVE;
  const waitlistedCount = counts.WAITLISTED;
  const redisGate = await getRedisGateSnapshot(offering.id);
  const redisActive = Number(redisGate.active ?? 0);
  const redisWaitlistSeq = Number(redisGate.waitlistSeq ?? 0);
  const capacityConsistent = activeCount <= offering.capacity;
  const counterConsistent = activeCount === offering.enrolledCount;
  const consistent = capacityConsistent && counterConsistent;
  const k6Summary = await readK6Summary();
  const report: LoadVerificationReport = {
    generatedAt: new Date().toISOString(),
    target: {
      offeringId: offering.id,
      courseNo: offering.course.courseNo,
      courseName: offering.course.name,
      classNo: offering.classNo,
      term: offering.term.name,
      capacity: offering.capacity,
      enrolledCount: offering.enrolledCount,
    },
    registrations: {
      active: activeCount,
      waitlisted: waitlistedCount,
      dropped: counts.DROPPED,
      removed: counts.REMOVED,
    },
    redis: {
      activeReserved: redisActive,
      waitlistSequence: redisWaitlistSeq,
    },
    consistency: {
      activeNotGreaterThanCapacity: capacityConsistent,
      enrolledCounterMatchesActive: counterConsistent,
      passed: consistent,
    },
    k6: {
      totalRequests: k6Metric(k6Summary, "http_reqs", "count"),
      p95DurationMs: k6Metric(k6Summary, "http_req_duration", "p(95)"),
      activeResponses: k6Metric(k6Summary, "active_responses", "count"),
      waitlistedResponses: k6Metric(k6Summary, "waitlisted_responses", "count"),
      successResponses: k6Metric(k6Summary, "success_responses", "count"),
      unknownSuccessResponses: k6Metric(k6Summary, "unknown_success_responses", "count"),
      businessRejects: k6Metric(k6Summary, "business_rejects", "count"),
      courseFullResponses: k6Metric(k6Summary, "course_full_responses", "count"),
      busyRejects: k6Metric(k6Summary, "busy_rejects", "count"),
      duplicateRejects: k6Metric(k6Summary, "duplicate_rejects", "count"),
      conflictRejects: k6Metric(k6Summary, "conflict_rejects", "count"),
      ruleRejects: k6Metric(k6Summary, "rule_rejects", "count"),
      otherBusinessRejects: k6Metric(k6Summary, "other_business_rejects", "count"),
      rateLimitedResponses: k6Metric(k6Summary, "rate_limited_responses", "count"),
      authRejects: k6Metric(k6Summary, "auth_rejects", "count"),
      serverErrors: k6Metric(k6Summary, "server_errors", "count"),
      handledOutcomeRate: k6Metric(k6Summary, "handled_outcomes", "rate"),
    },
  };

  await writeFile(verificationJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(verificationMarkdownPath, renderMarkdown(report), "utf8");

  console.log(`一致性校验: ${consistent ? "通过" : "失败"}`);
  console.log(`课程: ${offering.course.courseNo} ${offering.course.name}`);
  console.log(`容量: ${offering.capacity}`);
  console.log(`有效登记: ${activeCount}`);
  console.log(`候补登记: ${waitlistedCount}`);
  console.log(`Redis正式预占: ${redisActive}`);
  console.log(`Redis候补序号: ${redisWaitlistSeq}`);
  console.log(`Markdown摘要: ${verificationMarkdownPath}`);
  console.log(`JSON摘要: ${verificationJsonPath}`);
}

async function readK6Summary(): Promise<K6Summary | null> {
  if (!existsSync(k6SummaryPath)) {
    return null;
  }

  return JSON.parse(await readFile(k6SummaryPath, "utf8")) as K6Summary;
}

async function readLoadTarget(): Promise<LoadTarget | null> {
  if (!existsSync(targetPath)) {
    return null;
  }

  return JSON.parse(await readFile(targetPath, "utf8")) as LoadTarget;
}

async function resolveLoadOffering({
  offeringId,
  courseNo,
  classNo,
}: {
  offeringId?: string;
  courseNo: string;
  classNo: string;
}) {
  const include = {
    course: true,
    term: true,
  } as const;

  if (offeringId) {
    const offering = await prisma.courseOffering.findUnique({
      where: { id: offeringId },
      include,
    });

    if (offering) {
      return offering;
    }

    console.warn(
      `目标文件中的开课班ID已失效，将按课程号和班号重新查找：${courseNo} ${classNo}`,
    );
  }

  const offering = await prisma.courseOffering.findFirst({
    where: {
      classNo,
      course: {
        courseNo,
      },
      term: {
        isCurrent: true,
      },
    },
    include,
  });

  if (!offering) {
    throw new Error(
      `未找到压测课程 ${courseNo} ${classNo}班。请先运行 pnpm exec tsx scripts/seed-load-test.ts 重新准备压测数据。`,
    );
  }

  return offering;
}

function k6Metric(summary: K6Summary | null, name: string, key: string) {
  const value = summary?.metrics?.[name]?.values?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function renderMarkdown(report: LoadVerificationReport) {
  return `# 选课接口压力测试校验

生成时间：${report.generatedAt}

## 目标课程

| 字段 | 值 |
| --- | --- |
| 开课班 | ${report.target.courseNo} ${report.target.courseName} ${report.target.classNo}班 |
| 学期 | ${report.target.term} |
| 容量 | ${report.target.capacity} |
| 已选计数 | ${report.target.enrolledCount} |

## k6指标

| 指标 | 结果 |
| --- | --- |
| 总请求数 | ${formatNumber(report.k6.totalRequests)} |
| P95延迟 | ${report.k6.p95DurationMs.toFixed(1)}ms |
| 200响应 | ${formatNumber(report.k6.successResponses)} |
| 正式入选响应 | ${formatNumber(report.k6.activeResponses)} |
| 候补入队响应 | ${formatNumber(report.k6.waitlistedResponses)} |
| 未知成功响应 | ${formatNumber(report.k6.unknownSuccessResponses)} |
| 业务拒绝 | ${formatNumber(report.k6.businessRejects)} |
| 容量满响应 | ${formatNumber(report.k6.courseFullResponses)} |
| 忙碌拒绝 | ${formatNumber(report.k6.busyRejects)} |
| 重复提交拒绝 | ${formatNumber(report.k6.duplicateRejects)} |
| 时间冲突拒绝 | ${formatNumber(report.k6.conflictRejects)} |
| 规则拒绝 | ${formatNumber(report.k6.ruleRejects)} |
| 其他业务拒绝 | ${formatNumber(report.k6.otherBusinessRejects)} |
| 限流响应 | ${formatNumber(report.k6.rateLimitedResponses)} |
| 鉴权拒绝 | ${formatNumber(report.k6.authRejects)} |
| 服务错误 | ${formatNumber(report.k6.serverErrors)} |
| 应用可处理结果 | ${(report.k6.handledOutcomeRate * 100).toFixed(1)}% |

## 水平扩展说明

本次压测可通过Nginx入口访问多个Next.js实例，多个应用实例共享Redis抢课入口和PostgreSQL最终名单。校验重点不是单机页面吞吐，而是请求被分发后仍能保持正式入选不超过容量、已选计数与最终名单一致。

## 数据库一致性

| 校验项 | 结果 |
| --- | --- |
| 有效登记 | ${report.registrations.active} |
| 候补登记 | ${report.registrations.waitlisted} |
| 退课登记 | ${report.registrations.dropped} |
| 移除登记 | ${report.registrations.removed} |
| 有效登记不超过容量 | ${passText(report.consistency.activeNotGreaterThanCapacity)} |
| 已选计数匹配有效登记 | ${passText(report.consistency.enrolledCounterMatchesActive)} |
| 总体结论 | ${passText(report.consistency.passed)} |

## Redis预占状态

| 指标 | 结果 |
| --- | --- |
| 正式预占 | ${report.redis.activeReserved} |
| 候补序号 | ${report.redis.waitlistSequence} |
`;
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("zh-CN");
}

function passText(value: boolean) {
  return value ? "通过" : "失败";
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();

    if (redis.isOpen) {
      await redis.quit();
    }
  });
