import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    reporters: [
      "default",
      [
        "allure-vitest/reporter",
        {
          resultsDir: "artifacts/allure-results",
          environmentInfo: {
            Project: "基于Next.js的校园在线选课系统",
            Framework: "Next.js 16",
            Database: "PostgreSQL",
            Cache: "Redis",
            TestRunner: "Vitest",
          },
          categories: [
            {
              name: "业务规则",
              messageRegex: ".*(上课时间冲突|必修|选课数据不存在|课程).*",
              matchedStatuses: ["failed", "broken"],
            },
            {
              name: "并发一致性",
              messageRegex: ".*(write conflict|deadlock|超卖|候补|容量).*",
              matchedStatuses: ["failed", "broken"],
            },
            {
              name: "环境配置",
              messageRegex: ".*(ECONNREFUSED|P1001|database|Redis|Prisma).*",
              matchedStatuses: ["failed", "broken"],
            },
          ],
        },
      ],
    ],
  },
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
    },
  },
});
