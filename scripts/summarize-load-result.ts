import { RegistrationStatus } from "@prisma/client";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prisma } from "../lib/db/prisma";

const artifactDir = "artifacts";
const k6SummaryPath = `${artifactDir}/k6-enrollment-summary.json`;
const verificationJsonPath = `${artifactDir}/load-test-verification.json`;
const verificationMarkdownPath = `${artifactDir}/load-test-verification.md`;

type K6Summary = {
  metrics?: Record<string, { values?: Record<string, number> }>;
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
  consistency: {
    activeNotGreaterThanCapacity: boolean;
    enrolledCounterMatchesActive: boolean;
    passed: boolean;
  };
  k6: {
    totalRequests: number;
    p95DurationMs: number;
    successResponses: number;
    businessRejects: number;
    rateLimitedResponses: number;
    authRejects: number;
    serverErrors: number;
    handledOutcomeRate: number;
  };
};

async function main() {
  await mkdir(artifactDir, { recursive: true });

  const offeringId = process.env.LOAD_OFFERING_ID;
  const courseNo = process.env.LOAD_COURSE_NO || "SE304";
  const offering = await prisma.courseOffering.findFirstOrThrow({
    where: offeringId
      ? {
          id: offeringId,
        }
      : {
          course: {
            courseNo,
          },
        },
    include: {
      course: true,
      term: true,
    },
  });
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
    consistency: {
      activeNotGreaterThanCapacity: capacityConsistent,
      enrolledCounterMatchesActive: counterConsistent,
      passed: consistent,
    },
    k6: {
      totalRequests: k6Metric(k6Summary, "http_reqs", "count"),
      p95DurationMs: k6Metric(k6Summary, "http_req_duration", "p(95)"),
      successResponses: k6Metric(k6Summary, "success_responses", "count"),
      businessRejects: k6Metric(k6Summary, "business_rejects", "count"),
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
  console.log(`Markdown摘要: ${verificationMarkdownPath}`);
  console.log(`JSON摘要: ${verificationJsonPath}`);
}

async function readK6Summary(): Promise<K6Summary | null> {
  if (!existsSync(k6SummaryPath)) {
    return null;
  }

  return JSON.parse(await readFile(k6SummaryPath, "utf8")) as K6Summary;
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
| 成功响应 | ${formatNumber(report.k6.successResponses)} |
| 业务拒绝 | ${formatNumber(report.k6.businessRejects)} |
| 限流响应 | ${formatNumber(report.k6.rateLimitedResponses)} |
| 鉴权拒绝 | ${formatNumber(report.k6.authRejects)} |
| 服务错误 | ${formatNumber(report.k6.serverErrors)} |
| 应用可处理结果 | ${(report.k6.handledOutcomeRate * 100).toFixed(1)}% |

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
  });
