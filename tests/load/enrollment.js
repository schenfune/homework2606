import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

const activeResponses = new Counter("active_responses");
const waitlistedResponses = new Counter("waitlisted_responses");
const successResponses = new Counter("success_responses");
const unknownSuccessResponses = new Counter("unknown_success_responses");
const businessRejects = new Counter("business_rejects");
const courseFullResponses = new Counter("course_full_responses");
const busyRejects = new Counter("busy_rejects");
const duplicateRejects = new Counter("duplicate_rejects");
const conflictRejects = new Counter("conflict_rejects");
const ruleRejects = new Counter("rule_rejects");
const otherBusinessRejects = new Counter("other_business_rejects");
const rateLimitedResponses = new Counter("rate_limited_responses");
const authRejects = new Counter("auth_rejects");
const serverErrors = new Counter("server_errors");
const loginFailures = new Counter("login_failures");
const handledOutcomes = new Rate("handled_outcomes");

const mode = __ENV.MODE || "flash";
const baseUrl = __ENV.BASE_URL || "http://host.docker.internal:3000";
const targetFile = __ENV.TARGET_FILE || "../../artifacts/load-test-target.json";
const targetConfig = readTargetConfig();
const studentCount = Number(__ENV.STUDENT_COUNT || targetConfig?.studentCount || 200);
const targetCapacity = Number(targetConfig?.capacity || 0);
const waitlistStudentCount =
  targetConfig?.mode === "waitlist" ? studentCount : Math.max(1, studentCount - targetCapacity);
const defaultVus =
  mode === "flash"
    ? studentCount
    : mode === "waitlist"
    ? waitlistStudentCount
    : 100;
const vus = Number(__ENV.VUS || defaultVus);
const duration = __ENV.DURATION || "30s";
const maxDuration = __ENV.MAX_DURATION || "1m";
const sleepSeconds = Number(__ENV.SLEEP_SECONDS || (mode === "flash" ? 0 : 1));
const p95Threshold = Number(__ENV.P95_THRESHOLD_MS || (mode === "flash" ? 10000 : 2000));
const offeringId = __ENV.OFFERING_ID || targetConfig?.offeringId;
const targetEndpoint = mode === "waitlist" ? "/api/student/waitlist" : "/api/student/enrollments";
const manualCookies = (__ENV.SESSION_COOKIES || __ENV.SESSION_COOKIE || "")
  .split("|")
  .map((item) => item.trim())
  .filter(Boolean);

export const options = {
  setupTimeout: "5m",
  scenarios:
    mode === "flash"
      ? {
          enrollment_flash: {
            executor: "per-vu-iterations",
            vus,
            iterations: 1,
            maxDuration,
          },
        }
      : mode === "waitlist"
      ? {
          enrollment_waitlist: {
            executor: "per-vu-iterations",
            vus,
            iterations: 1,
            maxDuration,
          },
        }
      : {
          enrollment_rate_limit: {
            executor: "constant-vus",
            vus,
            duration,
          },
        },
  thresholds: {
    http_req_failed: ["rate==0"],
    http_req_duration: [`p(95)<${p95Threshold}`],
    server_errors: ["count==0"],
    handled_outcomes: ["rate>0.95"],
  },
};

export function setup() {
  if (!offeringId) {
    throw new Error("OFFERING_ID is required. Run scripts/seed-load-test.ts first.");
  }

  if (manualCookies.length > 0) {
    return {
      mode,
      offeringId,
      courseNo: targetConfig?.courseNo || __ENV.LOAD_COURSE_NO || "manual",
      courseName: targetConfig?.courseName || "手动压测课程",
      capacity: Number(targetConfig?.capacity || __ENV.LOAD_COURSE_CAPACITY || 0),
      studentCount: manualCookies.length,
      sessions: manualCookies.map((cookie, index) => ({
        studentNo: `manual-${index + 1}`,
        cookie,
      })),
    };
  }

  if (!targetConfig?.students?.length) {
    throw new Error(`${targetFile} is missing or contains no students.`);
  }

  const capacity = Number(targetConfig.capacity || 0);
  const students =
    mode === "flash"
      ? targetConfig.students.slice(0, vus)
      : mode === "waitlist"
      ? waitlistStudents(targetConfig, capacity).slice(0, vus)
      : [targetConfig.students[0]];
  const sessions = students.map((student) =>
    student.cookie
      ? {
          studentNo: student.studentNo,
          cookie: student.cookie,
        }
      : loginStudent(student),
  );

  return {
    mode,
    offeringId,
    courseNo: targetConfig.courseNo,
    courseName: targetConfig.courseName,
    capacity: targetConfig.capacity,
    studentCount: students.length,
    sessions,
  };
}

export default function enrollmentLoadTest(data) {
  const session =
    data.mode === "flash"
      ? data.sessions[(__VU - 1) % data.sessions.length]
      : data.sessions[(__VU + __ITER) % data.sessions.length];
  const response = http.post(
    `${baseUrl}${targetEndpoint}`,
    JSON.stringify({ offeringId: data.offeringId }),
    {
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
      },
      tags: {
        mode: data.mode,
        course: data.courseNo,
      },
    },
  );
  const handled = [200, 400, 403, 429].includes(response.status);

  handledOutcomes.add(handled);
  recordOutcome(response);

  check(response, {
    "handled by application": () => handled,
    "no server error": (res) => res.status < 500,
  });

  if (sleepSeconds > 0) {
    sleep(sleepSeconds);
  }
}

export function handleSummary(data) {
  return {
    "artifacts/k6-enrollment-summary.json": JSON.stringify(data, null, 2),
    "artifacts/k6-enrollment-report.html": buildHtmlReport(data),
    stdout: buildTextSummary(data),
  };
}

function loginStudent(student) {
  const response = http.post(
    `${baseUrl}/api/auth/sign-in/email`,
    JSON.stringify({
      email: student.email,
      password: student.password,
      rememberMe: true,
    }),
    {
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        referer: `${baseUrl}/login`,
      },
      tags: {
        mode,
        endpoint: "auth",
      },
    },
  );

  if (response.status !== 200) {
    loginFailures.add(1);
    throw new Error(`Login failed for ${student.studentNo}: ${response.status} ${response.body}`);
  }

  const cookie = cookieHeader(response.cookies);

  if (!cookie.includes("better-auth.session_token=")) {
    loginFailures.add(1);
    throw new Error(`Login did not return a Better Auth session cookie for ${student.studentNo}`);
  }

  return {
    studentNo: student.studentNo,
    cookie,
  };
}

function recordOutcome(response) {
  const body = parseResponseJson(response);

  if (response.status === 200) {
    successResponses.add(1);
    const status = body?.status;

    if (status === "ACTIVE") {
      activeResponses.add(1);
    } else if (status === "WAITLISTED") {
      waitlistedResponses.add(1);
    } else {
      unknownSuccessResponses.add(1);
    }
  } else if (response.status === 400) {
    businessRejects.add(1);
    recordBusinessReject(body?.message, body?.code);
  } else if (response.status === 403) {
    authRejects.add(1);
  } else if (response.status === 429) {
    rateLimitedResponses.add(1);
  } else if (response.status >= 500) {
    serverErrors.add(1);
  }
}

function parseResponseJson(response) {
  try {
    const value = response.json();
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function recordBusinessReject(message, code) {
  const text = String(message || "");

  if (code === "COURSE_FULL" || text.includes("容量")) {
    courseFullResponses.add(1);
  } else if (
    text.includes("正在提交") ||
    text.includes("正在更新") ||
    text.includes("提交冲突")
  ) {
    busyRejects.add(1);
  } else if (text.includes("已选择") || text.includes("已加入候补")) {
    duplicateRejects.add(1);
  } else if (text.includes("时间冲突")) {
    conflictRejects.add(1);
  } else if (
    text.includes("开放期") ||
    text.includes("必修") ||
    text.includes("专业年级") ||
    text.includes("冻结") ||
    text.includes("停开")
  ) {
    ruleRejects.add(1);
  } else {
    otherBusinessRejects.add(1);
  }
}

function cookieHeader(cookies) {
  return Object.keys(cookies)
    .map((name) => {
      const cookie = cookies[name]?.[0];
      return cookie ? `${name}=${cookie.value}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

function readTargetConfig() {
  try {
    return JSON.parse(open(targetFile));
  } catch {
    return null;
  }
}

function waitlistStudents(config, capacity) {
  if (config.mode === "waitlist") {
    return config.students;
  }

  return config.students.slice(capacity);
}

function buildTextSummary(data) {
  const title =
    mode === "flash"
      ? "多学生抢课压力测试摘要"
      : mode === "waitlist"
      ? "多学生候补压力测试摘要"
      : "单账号限流专项测试摘要";

  return [
    "",
    title,
    `模式: ${mode}`,
    `压测入口: ${baseUrl}`,
    `并发学生: ${mode === "flash" || mode === "waitlist" ? formatNumber(vus) : "1个账号高频提交"}`,
    `课程容量: ${formatNumber(Number(targetConfig?.capacity || 0))}`,
    `请求数: ${formatNumber(metric(data, "http_reqs", "count"))}`,
    `P95延迟: ${formatMs(metric(data, "http_req_duration", "p(95)"))}`,
    `正式入选响应: ${formatNumber(metric(data, "active_responses", "count"))}`,
    `候补入队响应: ${formatNumber(metric(data, "waitlisted_responses", "count"))}`,
    `未知成功响应: ${formatNumber(metric(data, "unknown_success_responses", "count"))}`,
    `业务拒绝: ${formatNumber(metric(data, "business_rejects", "count"))}`,
    `容量满响应: ${formatNumber(metric(data, "course_full_responses", "count"))}`,
    `忙碌拒绝: ${formatNumber(metric(data, "busy_rejects", "count"))}`,
    `重复提交拒绝: ${formatNumber(metric(data, "duplicate_rejects", "count"))}`,
    `时间冲突拒绝: ${formatNumber(metric(data, "conflict_rejects", "count"))}`,
    `规则拒绝: ${formatNumber(metric(data, "rule_rejects", "count"))}`,
    `其他业务拒绝: ${formatNumber(metric(data, "other_business_rejects", "count"))}`,
    `限流响应: ${formatNumber(metric(data, "rate_limited_responses", "count"))}`,
    `鉴权拒绝: ${formatNumber(metric(data, "auth_rejects", "count"))}`,
    `服务错误: ${formatNumber(metric(data, "server_errors", "count"))}`,
    "HTML报告: artifacts/k6-enrollment-report.html",
    "JSON摘要: artifacts/k6-enrollment-summary.json",
    "",
  ].join("\n");
}

function buildHtmlReport(data) {
  const total = metric(data, "http_reqs", "count");
  const active = metric(data, "active_responses", "count");
  const waitlisted = metric(data, "waitlisted_responses", "count");
  const unknown = metric(data, "unknown_success_responses", "count");
  const business = metric(data, "business_rejects", "count");
  const full = metric(data, "course_full_responses", "count");
  const nonFullBusiness = Math.max(0, business - full);
  const busy = metric(data, "busy_rejects", "count");
  const duplicate = metric(data, "duplicate_rejects", "count");
  const conflict = metric(data, "conflict_rejects", "count");
  const rule = metric(data, "rule_rejects", "count");
  const otherBusiness = metric(data, "other_business_rejects", "count");
  const limited = metric(data, "rate_limited_responses", "count");
  const auth = metric(data, "auth_rejects", "count");
  const server = metric(data, "server_errors", "count");
  const generatedAt = new Date().toISOString();
  const title =
    mode === "flash"
      ? "多学生抢课压力测试报告"
      : mode === "waitlist"
      ? "多学生候补压力测试报告"
      : "单账号限流专项测试报告";
  const cards = [
    ["模式", mode === "flash" ? "开选瞬间抢课" : mode === "waitlist" ? "满员后候补" : "单账号限流"],
    ["压测入口", baseUrl],
    ["并发学生", mode === "flash" || mode === "waitlist" ? formatNumber(vus) : "1个账号"],
    ["课程容量", formatNumber(Number(targetConfig?.capacity || 0))],
    ["总请求", formatNumber(total)],
    ["正式入选响应", formatNumber(active)],
    ["候补入队响应", formatNumber(waitlisted)],
    ["P95延迟", formatMs(metric(data, "http_req_duration", "p(95)"))],
    ["服务错误", formatNumber(server)],
  ];
  const outcomeRows = [
    ["正式入选", active, "#15803d"],
    ["候补入队", waitlisted, "#0369a1"],
    ["未知200", unknown, "#64748b"],
    ["容量满", full, "#f97316"],
    ["其他业务拒绝", nonFullBusiness, "#b45309"],
    ["限流", limited, "#7c3aed"],
    ["鉴权拒绝", auth, "#475569"],
    ["服务错误", server, "#b91c1c"],
  ];
  const rejectRows = [
    ["容量满响应", full],
    ["忙碌拒绝", busy],
    ["重复提交拒绝", duplicate],
    ["时间冲突拒绝", conflict],
    ["规则拒绝", rule],
    ["其他业务拒绝", otherBusiness],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --border: #d7dde7;
      --text: #172033;
      --muted: #667085;
      --bg: #f7f9fc;
      --panel: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
      line-height: 1.55;
    }
    main {
      width: min(1080px, calc(100vw - 48px));
      margin: 32px auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
      text-align: right;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgb(16 24 40 / 0.04);
    }
    .card { padding: 16px; }
    .label {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }
    .value {
      font-size: 24px;
      font-weight: 700;
    }
    .panel {
      margin-top: 16px;
      padding: 20px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 92px 1fr 84px;
      gap: 12px;
      align-items: center;
      margin: 10px 0;
      font-size: 14px;
    }
    .bar {
      height: 14px;
      border-radius: 999px;
      background: #e9edf5;
      overflow: hidden;
    }
    .bar > span {
      display: block;
      height: 100%;
      min-width: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: #f2f5f9;
    }
    @media (max-width: 760px) {
      main { width: min(100vw - 24px, 1080px); margin: 20px auto; }
      header { display: block; }
      .meta { text-align: left; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="label">${escapeHtml(targetConfig?.courseNo || "目标课程")} ${escapeHtml(
          targetConfig?.courseName || "",
        )}</div>
      </div>
      <div class="meta">
        <div>生成时间 ${escapeHtml(generatedAt)}</div>
        <div>目标接口 ${escapeHtml(baseUrl)}${escapeHtml(targetEndpoint)}</div>
      </div>
    </header>
    <section class="grid">
      ${cards
        .map(
          ([label, value]) => `<div class="card"><div class="label">${escapeHtml(
            label,
          )}</div><div class="value">${escapeHtml(value)}</div></div>`,
        )
        .join("")}
    </section>
    <section class="panel">
      <h2>响应结果分布</h2>
      ${outcomeRows
        .map(([label, count, color]) => {
          const width = total > 0 ? Math.round((Number(count) / total) * 100) : 0;
          return `<div class="bar-row">
            <div>${escapeHtml(String(label))}</div>
            <div class="bar"><span style="width:${width}%;background:${color}"></span></div>
            <div>${formatNumber(Number(count))}</div>
          </div>`;
        })
        .join("")}
    </section>
    <section class="panel">
      <h2>关键阈值</h2>
      <table>
        <thead><tr><th>指标</th><th>阈值</th><th>当前值</th></tr></thead>
        <tbody>
          <tr><td>服务错误</td><td>0</td><td>${formatNumber(server)}</td></tr>
          <tr><td>P95延迟</td><td>${formatNumber(p95Threshold)}ms以内</td><td>${formatMs(
            metric(data, "http_req_duration", "p(95)"),
          )}</td></tr>
          <tr><td>应用可处理结果</td><td>95%以上</td><td>${formatPercent(
            metric(data, "handled_outcomes", "rate"),
          )}</td></tr>
        </tbody>
      </table>
    </section>
    <section class="panel">
      <h2>水平扩展说明</h2>
      <table>
        <tbody>
          <tr><td>入口</td><td>${escapeHtml(baseUrl)}</td></tr>
          <tr><td>部署形态</td><td>Nginx反向代理到多个Next.js实例，Redis和PostgreSQL共享</td></tr>
          <tr><td>一致性目标</td><td>多实例同时接收请求时，正式入选不超过课程名额，最终名单与计数一致</td></tr>
        </tbody>
      </table>
    </section>
    <section class="panel">
      <h2>业务拒绝细分</h2>
      <table>
        <thead><tr><th>类型</th><th>数量</th></tr></thead>
        <tbody>
          ${rejectRows
            .map(
              ([label, count]) =>
                `<tr><td>${escapeHtml(label)}</td><td>${formatNumber(Number(count))}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function metric(data, name, key) {
  const value = data.metrics?.[name]?.values?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatNumber(value) {
  return String(Math.round(value));
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
