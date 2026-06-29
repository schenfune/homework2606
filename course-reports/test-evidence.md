# 测试证据整理

本文件为课程设计报告第七章准备测试材料。测试目标是证明核心业务规则、候补状态机、管理员追踪和并发一致性已经落实到可执行用例。

## 7.1 测试环境

表7.1记录建议写入报告的测试环境。具体版本以本机命令输出为准。

表7.1 测试环境

| 项目 | 内容 |
| --- | --- |
| 操作系统 | Windows开发环境 |
| 运行时 | Node.js和pnpm |
| Web框架 | Next.js 16 |
| ORM | Prisma 7 |
| 数据库 | PostgreSQL Docker容器，端口5432 |
| 缓存 | Redis Docker容器，端口6379 |
| 测试工具 | Vitest、ESLint、Next build、k6 |
| 浏览器 | Chrome或Edge |

## 7.2 测试策略

测试按三层组织。第一层是单元测试，验证课表时间区间重叠算法。第二层是服务层集成测试，直接调用选课服务和管理服务，验证事务、状态迁移和数据库一致性。第三层是系统级手动测试和压测脚本，验证页面流程、登录权限、缓存限流和高并发提交。

表7.2列出测试范围和优先级。

表7.2 测试范围

| 测试类型 | 目标 | 覆盖内容 | 优先级 |
| --- | --- | --- | --- |
| 单元测试 | 验证时间冲突算法 | 节次重叠、周次重叠、无冲突边界 | 高 |
| 集成测试 | 验证核心业务规则 | 选课、重复提交、候补、递补、停开课程 | 高 |
| 构建检查 | 验证类型和页面编译 | Next构建、服务端组件、Prisma类型 | 高 |
| 静态检查 | 验证代码规范 | ESLint规则、导入风格 | 中 |
| 压测脚本 | 验证并发入口 | HTTP选课接口、限流阈值、失败率 | 中 |
| 手动验收 | 验证演示流程 | 学生端、管理员端、CSV导出、结果API | 高 |

## 7.3 测试用例矩阵

表7.3将需求和测试文件建立映射。该表可直接放入报告，也可在答辩时说明测试覆盖重点。

表7.3 测试用例矩阵

| 编号 | 测试项 | 前置条件 | 测试步骤 | 预期结果 | 证据位置 |
| --- | --- | --- | --- | --- | --- |
| TC01 | 时间冲突算法 | 构造两组上课时间 | 调用`hasMeetingConflict` | 冲突和不冲突结果准确 | `tests/schedule.test.ts` |
| TC02 | 专业选修成功 | 学生20240001登录，课程SE301开放 | 调用`selectCourse` | 产生`ACTIVE`登记，已选人数加一 | `tests/enrollment.integration.test.ts` |
| TC03 | 重复选课 | 已存在同一课程登记 | 再次调用`selectCourse` | 系统拒绝，容量不重复增加 | `tests/enrollment.integration.test.ts` |
| TC04 | 必修课冲突 | 学生已有周一第1到2节必修课 | 选择SE302 | 系统返回时间冲突 | `tests/enrollment.integration.test.ts` |
| TC05 | 并发抢最后名额 | SE301容量改为1，两名学生同时提交 | 并发调用`selectCourse` | 一人有效，一人候补，容量仍为1 | `tests/enrollment.integration.test.ts` |
| TC06 | 规则诊断 | 学生打开选课页 | 查询课程规则项 | 可选课程无阻断，冲突课程标记时间冲突 | `tests/enrollment.integration.test.ts` |
| TC07 | 满员候补 | SE304容量为1，已有一名学生选中 | 第二名学生提交 | 产生`WAITLISTED`登记，顺位为1 | `tests/enrollment.integration.test.ts` |
| TC08 | 候补顺位 | GE204容量为1，三名学生提交 | 第二和第三名学生加入候补 | 顺位依次为1和2 | `tests/enrollment.integration.test.ts` |
| TC09 | 候补参与冲突 | 学生已候补GE202 | 再选同时间GE201 | 系统拒绝并提示时间冲突 | `tests/enrollment.integration.test.ts` |
| TC10 | 退课自动递补 | 一名学生有效，一名学生候补 | 有效学生退课 | 候补学生转为`ACTIVE`，容量仍为1 | `tests/enrollment.integration.test.ts` |
| TC11 | 退出候补 | 学生处于候补状态 | 调用`dropCourse` | 登记改为`DROPPED`，容量不变化 | `tests/enrollment.integration.test.ts` |
| TC12 | 管理员详情 | 存在退课、移除和日志 | 查询管理端dashboard | 详情含名单和相关日志 | `tests/admin.integration.test.ts` |
| TC13 | 停开含候补课程 | 课程含有效和候补登记 | 管理员停开课程 | 两类登记统一改为`REMOVED` | `tests/admin.integration.test.ts` |

## 7.4 命令验证记录

下列命令作为交付前验证入口。每次完成较大改动后运行一遍，保存关键输出即可。

```bash
pnpm exec prisma validate
pnpm exec prisma generate
pnpm exec tsx prisma/seed.ts
pnpm exec vitest run
pnpm lint
pnpm build
```

表7.4预留命令结果记录位置。

表7.4 命令验证结果

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm exec prisma validate` | 待填写 | 验证schema和Prisma配置 |
| `pnpm exec prisma generate` | 待填写 | 生成Prisma Client类型 |
| `pnpm exec tsx prisma/seed.ts` | 待填写 | 重置演示数据 |
| `pnpm exec vitest run` | 待填写 | 验证单元测试和集成测试 |
| `pnpm lint` | 待填写 | 验证代码规范 |
| `pnpm build` | 待填写 | 验证生产构建 |

## 7.5 问题分析素材

表7.5记录开发中已经出现并解决的问题。报告第七章可选择其中两到三个展开。

表7.5 问题分析记录

| 问题 | 原因 | 修复方案 | 验证方式 |
| --- | --- | --- | --- |
| Prisma 7不支持schema内写连接串 | Prisma 7将连接配置迁移到`prisma.config.ts` | 移除schema中的url，在配置文件中声明数据库地址 | `prisma validate` |
| advisory lock返回void反序列化失败 | Prisma适配器无法读取`pg_advisory_xact_lock`的void列 | 改用`pg_try_advisory_xact_lock`返回布尔值 | 手动选课和集成测试 |
| Seed脚本运行后进程不退出 | Redis连接仍保持打开 | Seed结束时断开Prisma和Redis连接 | 手动执行Seed |
| 并发测试偶发写冲突 | 多事务同时抢最后容量 | 使用Serializable事务、短暂重试和开课班锁 | 并发集成测试 |
| 集成测试互相重置数据库 | 测试文件共享同一个开发库 | 禁用测试文件并行执行 | `vitest run` |

## 7.6 压测说明

`tests/load/enrollment.js`用于选课HTTP接口压测。压测前需要启动本地服务，并准备目标开课班编号和登录会话Cookie。压测目标在于证明系统入口具备限流、缓存和容量一致性保护。

建议在报告中记录压测配置、并发用户数、请求失败率和数据库最终登记数量。若压测触发限流，说明Redis限流生效；若容量没有超卖，说明数据库事务和锁设计生效。

## 7.7 可视化测试报告与压测产物

可视化测试报告统一输出到`artifacts/`目录。Allure报告用于展示自动化测试用例、分组、耗时和失败定位；k6报告用于展示选课接口在并发请求下的响应分布、P95延迟、限流次数和服务错误数量；压测后数据库校验摘要用于证明有效登记数没有超过课程容量。

表7.6列出可视化报告生成命令。

表7.6 可视化报告命令

| 目标 | 命令 | 产物 |
| --- | --- | --- |
| 生成Allure结果 | `pnpm exec vitest run --config vitest.allure.config.ts` | `artifacts/allure-results` |
| 渲染Allure HTML | `allure generate artifacts/allure-results -o artifacts/allure-report --clean` | `artifacts/allure-report` |
| 检查k6脚本 | `k6 inspect --env OFFERING_ID=dummy --env SESSION_COOKIE=dummy tests/load/enrollment.js` | 场景和阈值配置 |
| 执行k6压测 | `k6 run --env BASE_URL=http://localhost:3000 --env OFFERING_ID=<开课班ID> --env SESSION_COOKIE="<登录Cookie>" tests/load/enrollment.js` | `artifacts/k6-enrollment-report.html`和JSON摘要 |
| 校验数据库结果 | `pnpm exec tsx scripts/summarize-load-result.ts` | `artifacts/load-test-verification.md`和JSON摘要 |

表7.7列出报告中建议截图的位置。

表7.7 可视化测试截图

| 位置 | 截图内容 | 说明 |
| --- | --- | --- |
| 7.3测试用例与结果 | Allure概览页 | 展示16个自动化测试用例通过 |
| 7.3测试用例与结果 | Allure用例详情页 | 展示候补、递补、管理员追踪等测试分组 |
| 7.3测试用例与结果 | k6 HTML报告 | 展示总请求、P95延迟、业务拒绝和限流 |
| 7.4问题分析与改进 | 压测后数据库校验摘要 | 展示有效登记不超过容量和计数一致 |
