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

测试按三层组织。第一层是单元测试，验证课表时间区间重叠算法。第二层是服务层集成测试，直接调用选课服务、候补服务、写回Worker和管理服务，验证预占、状态迁移和数据库一致性。第三层是系统级手动测试和压测脚本，验证页面流程、登录权限、Redis容量闸门、异步写回和高并发提交。

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
| TC05 | 并发抢最后名额 | SE301容量改为1，两名学生同时提交 | 并发调用`selectCourse`并执行Worker写回 | 一人有效，一人收到容量满，容量仍为1 | `tests/enrollment.integration.test.ts` |
| TC06 | 规则诊断 | 学生打开选课页 | 查询课程规则项 | 可选课程无阻断，冲突课程标记时间冲突 | `tests/enrollment.integration.test.ts` |
| TC07 | 满员候补 | SE304容量为1，已有一名学生选中 | 第二名学生显式调用`joinWaitlist`并执行Worker写回 | 产生`WAITLISTED`登记，顺位为1 | `tests/enrollment.integration.test.ts` |
| TC08 | 候补顺位 | GE204容量为1，三名学生提交 | 第二和第三名学生加入候补 | 顺位依次为1和2 | `tests/enrollment.integration.test.ts` |
| TC09 | 候补参与冲突 | 学生已候补GE202 | 再选同时间GE201 | 系统拒绝并提示时间冲突 | `tests/enrollment.integration.test.ts` |
| TC10 | 退课自动递补 | 一名学生有效，一名学生候补 | 有效学生退课 | 候补学生转为`ACTIVE`，容量仍为1 | `tests/enrollment.integration.test.ts` |
| TC11 | 退出候补 | 学生处于候补状态 | 调用`dropCourse` | 登记改为`DROPPED`，容量不变化 | `tests/enrollment.integration.test.ts` |
| TC12 | 管理员详情 | 存在退课、移除和日志 | 查询管理端dashboard | 详情含名单和相关日志 | `tests/admin.integration.test.ts` |
| TC13 | 停开含候补课程 | 课程含有效和候补登记 | 管理员停开课程 | 两类登记统一改为`REMOVED` | `tests/admin.integration.test.ts` |
| TC14 | Redis预占写回 | 学生提交正式选课或候补 | 处理Redis Stream任务 | Worker幂等写入登记并确认预占 | `tests/enrollment.integration.test.ts` |

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
| advisory lock返回void反序列化失败 | Prisma适配器无法读取`pg_advisory_xact_lock`的void列 | 学生重复提交锁使用`pg_try_advisory_xact_lock`；开课班排队锁使用`pg_advisory_xact_lock(...)::text` | 手动选课和集成测试 |
| Seed脚本运行后进程不退出 | Redis连接仍保持打开 | Seed结束时断开Prisma和Redis连接 | 手动执行Seed |
| 并发测试偶发写冲突 | 多事务同时抢最后容量和候补顺位 | 使用Read Committed事务、学生锁和开课班名单锁串行化名单变更 | 并发集成测试、k6压测 |
| 集成测试互相重置数据库 | 测试文件共享同一个开发库 | 禁用测试文件并行执行 | `vitest run` |
| 抢课P95偏高 | 同步事务在请求线程中排队写库 | 用Redis Lua脚本完成入口预占，Worker异步写回PostgreSQL | k6多学生抢课报告 |
| Redis Stream解析不兼容 | Redis客户端返回对象形态而非RESP数组形态 | 写回Worker兼容对象和数组两种解析结果 | Worker集成测试 |

## 7.6 压测说明

`tests/load/enrollment.js`用于选课HTTP接口压测。压测前先运行`pnpm exec tsx scripts/seed-load-test.ts`生成专用压测课程和压测学生。主压测采用多学生同时抢课模式，目标在于证明开选瞬间Redis预占能够快速判定正式名额，容量外学生收到结构化`COURSE_FULL`，数据库最终登记不超卖。候补压测单独运行`MODE=waitlist`，用于证明满员后显式候补可以稳定入队。单账号重复提交只作为限流专项，用来证明Redis会拦截异常高频请求。

建议在报告中记录压测配置、并发学生数、课程容量、正式预占响应数、容量满响应数、候补入队响应数、P95延迟、服务端错误数、Redis闸门状态和数据库最终登记数量。抢课主报告的理想结果是正式入选响应等于课程容量、容量满响应等于剩余提交学生数、服务错误为0；候补报告的理想结果是候补入队响应等于候补提交人数。压测后运行Worker并执行汇总脚本，若有效登记数不超过课程容量、`enrolledCount`匹配有效登记、Redis正式预占数与最终登记一致，可以说明系统在并发抢课下保持了业务一致性。

## 7.7 可视化测试报告与压测产物

可视化测试报告统一输出到`artifacts/`目录。Allure报告用于展示自动化测试用例、分组、耗时和失败定位；k6主报告用于展示多学生抢课下的正式入选、候补入队、P95延迟和服务错误数量；压测后数据库校验摘要用于证明有效登记数没有超过课程容量，且`enrolledCount`与有效登记数量一致。

表7.6列出可视化报告生成命令。

表7.6 可视化报告命令

| 目标 | 命令 | 产物 |
| --- | --- | --- |
| 生成Allure结果 | `pnpm exec vitest run --config vitest.allure.config.ts` | `artifacts/allure-results` |
| 渲染Allure HTML | `allure generate artifacts/allure-results -o artifacts/allure-report --clean` | `artifacts/allure-report` |
| 准备压测数据 | `pnpm exec tsx scripts/seed-load-test.ts` | `artifacts/load-test-target.json` |
| 检查k6脚本 | `k6 inspect tests/load/enrollment.js` | 场景和阈值配置 |
| 执行多学生抢课 | `k6 run --env MODE=flash --env BASE_URL=http://localhost:3000 tests/load/enrollment.js` | `artifacts/k6-enrollment-report.html`和JSON摘要 |
| 执行候补压测 | `k6 run --env MODE=waitlist --env BASE_URL=http://localhost:3000 tests/load/enrollment.js` | 满员后显式候补摘要 |
| 执行写回Worker | `$env:ENROLLMENT_WORKER_BATCH="500"; $env:ENROLLMENT_WORKER_ONCE="1"; pnpm exec tsx scripts/enrollment-worker.ts` | 将Redis预占写回PostgreSQL |
| 执行限流专项 | `k6 run --env MODE=rate-limit --env BASE_URL=http://localhost:3000 tests/load/enrollment.js` | 单账号高频提交摘要 |
| 校验数据库结果 | `pnpm exec tsx scripts/summarize-load-result.ts` | `artifacts/load-test-verification.md`和JSON摘要 |

表7.7列出报告中建议截图的位置。

表7.7 可视化测试截图

| 位置 | 截图内容 | 说明 |
| --- | --- | --- |
| 7.3测试用例与结果 | Allure概览页 | 展示16个自动化测试用例通过 |
| 7.3测试用例与结果 | Allure用例详情页 | 展示候补、递补、管理员追踪等测试分组 |
| 7.3测试用例与结果 | k6主压测HTML报告 | 展示并发学生、课程容量、正式入选、候补入队和P95延迟 |
| 7.4问题分析与改进 | 压测后数据库校验摘要 | 展示有效登记不超过容量和计数一致 |
