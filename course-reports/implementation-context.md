# 实现上下文摘要

## 当前业务边界

系统定位为校园教务体系中的选课子系统。外部教务主系统通过Seed数据提供学生档案、课程、开课班和必修课表。本系统只处理学生选退课、课表查看、选课开放期、名单冻结、课程停开、统计、日志、CSV导出和结果API。

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

Prisma 7的PostgreSQL适配器无法反序列化`pg_advisory_xact_lock`返回的`void`列。选退课服务中，同一学生提交锁使用`pg_try_advisory_xact_lock`快速拒绝重复提交；开课班名单锁使用`pg_advisory_xact_lock(...)::text`排队串行化容量和候补顺位更新，避免高并发抢课时把正常排队误判为业务失败。

由于用户要求不直接编辑依赖安装结果，当前没有在`package.json`中添加脚本。依赖安装后，可通过`pnpm exec prisma validate`、`pnpm exec prisma generate`、`pnpm exec tsx prisma/seed.ts`、`pnpm exec vitest run`等命令运行。

## 当前测试设计

单元测试先覆盖课表时间冲突判断。学生正式选课HTTP接口位于`/api/student/enrollments`，候补接口位于`/api/student/waitlist`，二者共同供API测试和k6压测使用。`scripts/seed-load-test.ts`会生成专用压测课程、压测学生和`artifacts/load-test-target.json`，k6脚本可在`setup()`阶段自动登录压测学生并获取会话Cookie，不再依赖手工复制浏览器Cookie。

## 已实现代码概览

已添加Prisma领域模型、Better Auth认证配置、scrypt密码哈希、Seed演示数据、学生选课服务、管理员管理服务、Redis缓存限流、学生端页面、管理员端页面、CSV导出、结果API、课表冲突单元测试和k6压测脚本。当前`package.json`未记录新增依赖，需用户手动安装依赖后再运行校验。

## 学生界面重构

学生端已改为顶部摘要、选课和课表标签页、课程表格、课程详情抽屉。规则说明不再以段落出现在页面中，改用短状态标签、容量进度、禁用按钮和悬浮提示表达。登录页和管理员页也删除了明显的报告口吻说明文字。

## 测试加固

新增服务层集成测试，覆盖专业选修成功、重复选课不重复占用容量、必修课时间冲突、并发抢最后一个名额不超卖。集成测试会调用Seed重置演示数据，因此运行`vitest run`会刷新开发库状态。

集成测试曾触发`pg`关于同一连接查询队列的弃用警告，事务内查询已改为顺序执行。当前正式选课入口使用Redis Lua脚本原子预占，退课和Worker写回使用Read Committed事务配合学生锁和开课班锁：学生锁处理同一学生重复提交，开课班锁保护最终容量计数、候补顺位和递补顺序。当前并发抢课测试可以通过，但`@prisma/adapter-pg`在事务测试场景下仍可能由底层`pg`打印`client.query()`弃用警告；这属于依赖层提示，不影响业务断言。项目通过`tests/setup.ts`在Vitest进程中精确过滤该已知提示，不影响其他warning输出。若要从依赖层面消除该告警，可后续关注Prisma适配器或`pg@9`兼容更新。

由于服务层集成测试共享同一个PostgreSQL开发库，且每个用例会调用Seed重置数据，Vitest配置为`fileParallelism: false`，避免不同测试文件并行重置数据造成外键或记录不存在的竞态。

## ICONIX导向增强

学生端课程详情增加结构化规则诊断，服务层返回开放期、课程状态、课程类别、专业年级、容量、时间冲突六类`ruleChecks`。这使学生选课用例可以追踪到边界对象、控制对象和实体对象。边界对象包括学生页面和课程详情；控制对象包括选课规则诊断和选课事务服务；实体对象包括学生、开课班、资格规则和选课记录。

管理员端增加课程详情抽屉，从课程统计下钻到基础信息、容量进度、登记名单和相关操作日志。该增强支撑冻结课程名单、停开课程、查看选课结果用例的鲁棒分析和时序分析，不新增数据库表，直接复用`CourseOffering`、`CourseRegistration`和`OperationLog`。

管理员控制台拆分为`/admin/window`、`/admin/stats`和`/admin/logs`三个工作区。开放期、课程统计和操作日志分别成为独立边界对象，`/admin`默认进入课程统计工作区。课程详情抽屉只保留在统计工作区，关闭后回到`/admin/stats`。

学生课表页增加按星期与节次展开的占用矩阵，单元格展示课程名、班号、教学周和状态。该矩阵按`ACTIVE`与未来的`WAITLISTED`登记记录渲染，体现候补课程占用意向课表的规则。

Seed演示数据增加低容量课程和时间冲突课程，覆盖专业选修与公选课，用于演示容量满员、候补队列、时间冲突诊断和课表矩阵自动扩展。登录页删除学生/管理员快捷填充按钮，仅保留默认演示账号值。

## 候补状态机增强

候补按ICONIX领域分析中的统一业务词汇建模为`CourseRegistration`的生命周期状态。登记状态扩展为`ACTIVE`、`WAITLISTED`、`DROPPED`、`REMOVED`：正式选课、候补、退课、移除都属于同一个选课登记领域对象的不同时刻。候补队列由同一开课班下`WAITLISTED`登记按`waitlistPosition`排序形成，避免把技术实现拆成与业务语言不一致的额外概念。

鲁棒分析中，学生选课页、课程详情抽屉、课表矩阵和管理员课程详情抽屉是边界对象；选课意图服务、RedisSeatGate、EnrollmentWritebackWorker、退课递补服务和规则诊断构造器是控制对象；学生档案、开课班、选课登记、资格规则、上课时间、Redis Reservation和操作日志是实体对象或临时领域状态。满员候补场景的关键时序为：学生先尝试正式选课、Redis闸门返回`COURSE_FULL`、页面显示候补入口、学生显式提交候补、Worker异步创建`WAITLISTED`登记、分配候补顺位、写入操作日志并刷新课表。退课递补场景的关键时序为：学生退正式课、登记变为`DROPPED`、释放容量、查找队首候补、候补登记转为`ACTIVE`、恢复容量计数并写入递补日志。

候补课程占用意向课表并参与时间冲突判断，但不计入已登记学分和`enrolledCount`。释放名额时采用FIFO自动递补，冻结名单只锁定名单，停开课程会将正式登记和候补登记统一置为`REMOVED`。这些规则可在答辩中对应到用例扩展事件流、领域模型状态迁移、时序图和结构设计中的事务一致性控制。

## Redis预占与异步写回

为降低开选瞬间P95延迟，正式选课入口从“同步写PostgreSQL事务”调整为“Redis预占 + Worker异步写回”。`RedisSeatGate`作为控制对象维护开课班容量闸门：容量、已预占正式数、候补序号和初始化状态都保存在Redis中。`Reservation`是只存在于Redis的临时领域状态，状态包括`ACTIVE_RESERVED`、`WAITLIST_RESERVED`、`CONFIRMED_ACTIVE`、`CONFIRMED_WAITLIST`和`FAILED`，默认TTL为30分钟。

学生点击“选课”只抢正式名额。若Redis闸门仍有余量，Lua脚本原子增加正式预占数、写入学生开课班预占记录，并向Redis Stream追加写回任务；前端立即显示已入课表。若容量已满，`selectCourse`返回结构化错误`COURSE_FULL`，页面刷新后显示“候补”按钮。学生只有再次点击“候补”时才调用`joinWaitlist`，候补预占只增加候补序号，不增加正式名额，也不计入已选学分。

`EnrollmentWritebackWorker`独立消费Redis Stream，运行方式为`pnpm exec tsx scripts/enrollment-worker.ts`。Worker使用开课班级别的PostgreSQL advisory lock保护最终登记一致性，幂等写入`CourseRegistration`和`OperationLog`。数据库事务提交成功后，Worker再把Redis预占标记为确认；若课程已停开、容量被数据库最终校验拒绝或写回失败，则释放预占并让学生下次刷新看到最新状态。PostgreSQL仍是最终登记和审计存储，Redis负责短期入口削峰和即时交互反馈。

这个优化补充了ICONIX链路中的两个控制对象：`RedisSeatGate`处理高并发容量判定，`EnrollmentWritebackWorker`处理异步确认登记。用例也拆成“学生选课”“学生加入候补”“异步确认登记”“失败释放预占”，比单个同步事务更能说明性能、扩展性和一致性之间的设计取舍。

## 异步一致性运维闭环

管理员端新增`/admin/ops`一致性运维工作区，作为异步选课架构的可观测边界对象。该页面按开课班展示PostgreSQL有效登记、`enrolledCount`、Redis正式预占、正式待写、候补待写、失败预占和一致性校验结果。状态分为正常、待写回、需处理和异常，便于答辩时展示系统不仅能承受高并发，也能解释异步写回中的中间状态。

`EnrollmentOpsService`作为控制对象负责扫描Redis reservation、Redis gate和PostgreSQL登记，形成一致性快照；管理员可触发处理写回，服务会幂等重投`ACTIVE_RESERVED`和`WAITLIST_RESERVED`任务并复用`EnrollmentWritebackWorker`处理一批任务；管理员也可清理`FAILED`或悬空reservation。该功能不新增数据库表，不改变业务登记模型，只补齐Redis短期权威与PostgreSQL最终权威之间的运维闭环。

## 答辩证据包

`course-reports/iconix-modeling.md`整理了核心用例文本、领域模型、选课登记状态机、鲁棒分析对象清单和需求追踪矩阵。该文档服务报告第二章系统分析，也能在答辩中直接回应老师关于ICONIX和领域建模的提问。

`course-reports/sequence-diagrams.md`整理了正常选课、满员候补、退课自动递补和管理员停开课程四个关键时序。图中区分学生页面、管理页面、事务服务、规则诊断、数据库、Redis缓存和操作日志，便于说明对象交互顺序和职责分配。

`course-reports/test-evidence.md`整理了测试环境、测试策略、测试用例矩阵、命令验证记录、压测报告和问题分析素材。该文档服务报告第七章，可将用户手动运行的`vitest`、`lint`、`build`和k6输出填入预留表格。

`course-reports/defense-demo-script.md`整理了8到10分钟演示路线、账号课程清单、讲稿要点、备用路径和截图位置。演示主线为学生端规则诊断、候补入队、退课递补、管理员追踪、测试证据和ICONIX总结。

## 可视化测试与压力测试

新增Allure风格测试报告和k6压测证据链。`vitest.allure.config.ts`复用现有Vitest测试集合，将结果输出到`artifacts/allure-results`，生成HTML时输出到`artifacts/allure-report`。`scripts/seed-load-test.ts`生成`LT101`专用压测课程、200个压测学生和`artifacts/load-test-target.json`，并预置Better Auth会话Cookie，避免主压测被登录接口限流干扰。`tests/load/enrollment.js`支持`flash`、`waitlist`和`rate-limit`三种模式：`flash`模拟多学生同时抢正式名额，预期容量内学生快速获得`ACTIVE`预占、其余学生收到`COURSE_FULL`；`scripts/prepare-waitlist-load-test.ts`会在抢课后读取Redis真实正式预占名单，生成`artifacts/load-test-waitlist-target.json`，保证候补压测只使用未抢到正式名额的学生；`waitlist`模拟满员后显式候补；`rate-limit`保留单账号高频提交限流专项。k6摘要会区分正式入选、候补入队、容量满、忙碌拒绝、重复提交、时间冲突、规则拒绝和服务错误，方便定位压测异常。`scripts/summarize-load-result.ts`在压测后读取Redis闸门和PostgreSQL登记，生成`artifacts/load-test-verification.md`和JSON摘要，重点证明Redis预占数、有效登记数、课程容量和`enrolledCount`最终一致。
