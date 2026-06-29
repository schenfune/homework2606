# 实现上下文摘要

## 当前业务边界

系统定位为校园教务体系中的选课子系统。外部教务主系统通过Seed数据提供学生档案、课程、开课班和必修课表。本系统只处理学生选退课、课表查看、选课开放期、课程关闭取消、统计、日志、CSV导出和结果API。

## 已确认领域规则

课程类别包括必修课、专业选修课、公选课。必修课通过课程类别识别，不增加来源字段。课程登记记录统一承载必修课登记和学生选课记录。必修课不可退，专业选修课校验学院、专业、年级，公选课默认全校可选。时间冲突检测覆盖必修课和已选课程。

## 当前技术方向

Next.js 16使用App Router。认证使用Better Auth模拟统一身份认证。PostgreSQL保存权威业务数据。Redis负责缓存和限流。Prisma schema承载领域模型。UI尽量采用shadcn风格组件，优先使用Card和Table组织学生端与后台页面。

## 实现注意

不要在本系统中扩展完整教务后台，不做教师端，不做课程库维护，不做账号生命周期管理。Better Auth只负责登录、退出、会话保护。学号和工号通过username插件表达，实际账号仍映射到本地认证表。

## 待手动安装依赖

代码将使用Prisma、Better Auth、Redis客户端、shadcn风格工具函数、Vitest等依赖。按照项目约定，Codex不直接安装依赖。需要用户手动执行安装命令后，才能运行类型检查、Prisma生成和构建。

建议命令：

```bash
pnpm add @prisma/client @prisma/adapter-pg better-auth clsx redis tailwind-merge
pnpm add -D prisma tsx vitest
```

当前实际安装的是Prisma 7。Prisma 7不再允许在`schema.prisma`中写`datasource.url`，项目已改为在`prisma.config.ts`中配置CLI连接串，并在运行时通过`@prisma/adapter-pg`创建PrismaClient。

Better Auth在本地开发中使用显式默认`baseURL`和开发密钥，避免构建阶段使用库内置默认值。正式部署时必须配置`BETTER_AUTH_URL`和足够长的`BETTER_AUTH_SECRET`。

Prisma 7的PostgreSQL适配器无法反序列化`pg_advisory_xact_lock`返回的`void`列。选退课事务已改用`pg_try_advisory_xact_lock`返回布尔值，获取不到同一学生锁时直接提示稍后再试。

由于用户要求不直接编辑依赖安装结果，当前没有在`package.json`中添加脚本。依赖安装后，可通过`pnpm exec prisma validate`、`pnpm exec prisma generate`、`pnpm exec tsx prisma/seed.ts`、`pnpm exec vitest run`等命令运行。

## 当前测试设计

单元测试先覆盖课表时间冲突判断。学生选课HTTP接口位于`/api/student/enrollments`，供API测试和k6压测使用。k6脚本位于`tests/load/enrollment.js`，需要手动传入`BASE_URL`、`OFFERING_ID`和登录后的`SESSION_COOKIE`。

## 已实现代码概览

已添加Prisma领域模型、Better Auth认证配置、scrypt密码哈希、Seed演示数据、学生选课服务、管理员管理服务、Redis缓存限流、学生端页面、管理员端页面、CSV导出、结果API、课表冲突单元测试和k6压测脚本。当前`package.json`未记录新增依赖，需用户手动安装依赖后再运行校验。

## 学生界面重构

学生端已改为顶部摘要、选课和课表标签页、课程表格、课程详情抽屉。规则说明不再以段落出现在页面中，改用短状态标签、容量进度、禁用按钮和悬浮提示表达。登录页和管理员页也删除了明显的报告口吻说明文字。

## 测试加固

新增服务层集成测试，覆盖专业选修成功、重复选课不重复占用容量、必修课时间冲突、并发抢最后一个名额不超卖。集成测试会调用Seed重置演示数据，因此运行`vitest run`会刷新开发库状态。

集成测试曾触发`pg`关于同一连接查询队列的弃用警告，事务内查询已改为顺序执行，选课和退课都统一使用Serializable事务与短暂重试。当前并发抢课测试可以通过，但`@prisma/adapter-pg`在事务测试场景下仍可能由底层`pg`打印`client.query()`弃用警告；这不是业务断言失败。项目通过`tests/setup.ts`在Vitest进程中精确过滤该已知提示，不影响其他warning输出。若要从依赖层面消除该告警，可后续关注Prisma适配器或`pg@9`兼容更新。

## ICONIX导向增强

学生端课程详情增加结构化规则诊断，服务层返回开放期、课程状态、课程类别、专业年级、容量、时间冲突六类`ruleChecks`。这使“学生选课”用例可以追踪到边界对象（学生页面/课程详情）、控制对象（选课规则诊断与选课事务服务）和实体对象（学生、开课班、资格规则、选课记录）。

管理员端增加课程详情抽屉，从课程统计下钻到基础信息、容量进度、登记名单和相关操作日志。该增强支撑“关闭课程名单”“取消开课班”“查看选课结果”用例的鲁棒分析和时序分析，不新增数据库表，直接复用`CourseOffering`、`CourseRegistration`和`OperationLog`。
