import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

const successResponses = new Counter("success_responses");
const businessRejects = new Counter("business_rejects");
const rateLimitedResponses = new Counter("rate_limited_responses");
const authRejects = new Counter("auth_rejects");
const serverErrors = new Counter("server_errors");
const handledOutcomes = new Rate("handled_outcomes");

const vus = Number(__ENV.VUS || 100);
const duration = __ENV.DURATION || "30s";
const sleepSeconds = Number(__ENV.SLEEP_SECONDS || 1);

export const options = {
  scenarios: {
    enrollment_load: {
      executor: "constant-vus",
      vus,
      duration,
    },
  },
  thresholds: {
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<1000"],
    server_errors: ["count==0"],
    handled_outcomes: ["rate>0.95"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://host.docker.internal:3000";
const offeringId = __ENV.OFFERING_ID;
const cookies = (__ENV.SESSION_COOKIES || __ENV.SESSION_COOKIE || "")
  .split("|")
  .map((item) => item.trim())
  .filter(Boolean);

if (!offeringId) {
  throw new Error("OFFERING_ID is required");
}

if (cookies.length === 0) {
  throw new Error("SESSION_COOKIE or SESSION_COOKIES is required");
}

export default function enrollmentLoadTest() {
  const cookie = cookies[(__VU + __ITER) % cookies.length];
  const response = http.post(
    `${baseUrl}/api/student/enrollments`,
    JSON.stringify({ offeringId }),
    {
      headers: {
        "content-type": "application/json",
        cookie,
      },
    },
  );
  const handled = [200, 400, 403, 429].includes(response.status);

  handledOutcomes.add(handled);

  if (response.status === 200) {
    successResponses.add(1);
  } else if (response.status === 400) {
    businessRejects.add(1);
  } else if (response.status === 403) {
    authRejects.add(1);
  } else if (response.status === 429) {
    rateLimitedResponses.add(1);
  } else if (response.status >= 500) {
    serverErrors.add(1);
  }

  check(response, {
    "handled by application": () => handled,
    "no server error": (res) => res.status < 500,
  });

  sleep(sleepSeconds);
}

export function handleSummary(data) {
  return {
    "artifacts/k6-enrollment-summary.json": JSON.stringify(data, null, 2),
    "artifacts/k6-enrollment-report.html": buildHtmlReport(data),
    stdout: buildTextSummary(data),
  };
}

function buildTextSummary(data) {
  return [
    "",
    "选课接口压力测试摘要",
    `请求数: ${formatNumber(metric(data, "http_reqs", "count"))}`,
    `P95延迟: ${formatMs(metric(data, "http_req_duration", "p(95)"))}`,
    `成功响应: ${formatNumber(metric(data, "success_responses", "count"))}`,
    `业务拒绝: ${formatNumber(metric(data, "business_rejects", "count"))}`,
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
  const success = metric(data, "success_responses", "count");
  const business = metric(data, "business_rejects", "count");
  const limited = metric(data, "rate_limited_responses", "count");
  const auth = metric(data, "auth_rejects", "count");
  const server = metric(data, "server_errors", "count");
  const generatedAt = new Date().toISOString();

  const cards = [
    ["总请求", formatNumber(total)],
    ["P95延迟", formatMs(metric(data, "http_req_duration", "p(95)"))],
    ["平均延迟", formatMs(metric(data, "http_req_duration", "avg"))],
    ["服务错误", formatNumber(server)],
    ["成功响应", formatNumber(success)],
    ["业务拒绝", formatNumber(business)],
    ["限流响应", formatNumber(limited)],
    ["鉴权拒绝", formatNumber(auth)],
  ];
  const outcomeRows = [
    ["成功", success, "#15803d"],
    ["业务拒绝", business, "#b45309"],
    ["限流", limited, "#7c3aed"],
    ["鉴权拒绝", auth, "#0369a1"],
    ["服务错误", server, "#b91c1c"],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>选课接口压力测试报告</title>
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
    .card {
      padding: 16px;
    }
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
        <h1>选课接口压力测试报告</h1>
        <div class="label">目标接口 ${escapeHtml(baseUrl)}/api/student/enrollments</div>
      </div>
      <div class="meta">
        <div>生成时间 ${escapeHtml(generatedAt)}</div>
        <div>虚拟用户 ${escapeHtml(String(vus))}，持续 ${escapeHtml(duration)}</div>
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
          <tr><td>P95延迟</td><td>1000ms以内</td><td>${formatMs(
            metric(data, "http_req_duration", "p(95)"),
          )}</td></tr>
          <tr><td>应用可处理结果</td><td>95%以上</td><td>${formatPercent(
            metric(data, "handled_outcomes", "rate"),
          )}</td></tr>
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
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
