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

代码将使用Prisma、Better Auth、Redis客户端、shadcn风格工具函数、Vitest等依赖。项目约定由用户手动安装依赖，Codex不直接安装依赖。需要用户手动执行安装命令后，才能运行类型检查、Prisma生成和构建。

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

新增`tests/password.test.ts`覆盖本地密码哈希工具，验证正确密码、错误密码、随机盐、坏格式hash和存储密钥长度异常等分支。针对`lib/auth/password.ts`单独运行覆盖率时，语句、分支、函数和行覆盖率均为100%。

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

`course-reports/iconix-modeling.md`整理了核心用例文本、领域模型、选课登记状态机、鲁棒分析对象清单和需求追踪矩阵。该文档服务报告第二章系统分析，也能在答辩中支撑ICONIX和领域建模相关讲解。

`course-reports/sequence-diagrams.md`整理了正常选课、满员候补、退课自动递补和管理员停开课程四个关键时序。图中区分学生页面、管理页面、事务服务、规则诊断、数据库、Redis缓存和操作日志，便于说明对象交互顺序和职责分配。

`course-reports/test-evidence.md`整理了测试环境、测试策略、测试用例矩阵、命令验证记录、压测报告和问题分析素材。该文档服务报告第七章，可将用户手动运行的`vitest`、`lint`、`build`和k6输出填入预留表格。

`course-reports/defense-demo-script.md`整理了8到10分钟演示路线、账号课程清单、讲稿要点、备用路径和截图位置。演示主线为学生端规则诊断、候补入队、退课递补、管理员追踪、测试证据和ICONIX总结。

## 可视化测试与压力测试

新增Allure风格测试报告和k6压测证据链。`vitest.allure.config.ts`复用现有Vitest测试集合，将结果输出到`artifacts/allure-results`，生成HTML时输出到`artifacts/allure-report`。`scripts/seed-load-test.ts`生成`LT101`专用压测课程、200个压测学生和`artifacts/load-test-target.json`，并预置Better Auth会话Cookie，避免主压测被登录接口限流干扰。`tests/load/enrollment.js`支持`flash`、`waitlist`和`rate-limit`三种模式：`flash`模拟多学生同时抢正式名额，预期容量内学生快速获得`ACTIVE`预占、其余学生收到`COURSE_FULL`；`scripts/prepare-waitlist-load-test.ts`会在抢课后读取Redis真实正式预占名单，生成`artifacts/load-test-waitlist-target.json`，保证候补压测只使用未抢到正式名额的学生；`waitlist`模拟满员后显式候补；`rate-limit`保留单账号高频提交限流专项。k6摘要会区分正式入选、候补入队、容量满、忙碌拒绝、重复提交、时间冲突、规则拒绝和服务错误，方便定位压测异常。`scripts/summarize-load-result.ts`在压测后读取Redis闸门和PostgreSQL登记，生成`artifacts/load-test-verification.md`和JSON摘要，重点证明Redis预占数、有效登记数、课程容量和`enrolledCount`最终一致。

## 界面语言优化

为避免答辩演示时页面出现过多内部术语，前端文案按“业务可读、技术可追踪”的原则调整。学生课程详情将“规则”改为“选课检查”，将检查项显示为选课时间、开课状态、课程类型、适合对象、名额和上课时间，状态使用“可以、不能、注意”，不直接暴露`pass`、`block`、`info`等实现状态。

管理员统计页将“有效、移除、容量”等容易产生疑问的列名改为“已选、停开移除、名额”。管理员数据校验页仍然对照Redis入口、Worker待处理任务和PostgreSQL最终名单，但界面表头改为“抢课入口已选、已选待入库、最终已选、最终候补”等表达；专业术语保留在代码、报告和答辩讲解中，不直接堆在控制台表格里。

操作日志不再直接显示`COURSE_SELECTED`、`ADMIN`等枚举值，统一转换成“学生选课、加入候补、管理员”等中文动作和角色。这样页面适合现场快速扫读，报告仍能通过实现文档解释背后的ICONIX控制对象和领域状态。

## Prisma模型注释

`prisma/schema.prisma`已为绝大多数模型字段补充短中文注释，认证模型、学生档案、学院专业、学期、课程、开课班、上课时间、资格规则、选课记录和操作日志都能直接从字段旁看出含义。注释只用于提升领域模型可读性，不改变表结构、索引、关系或运行逻辑。

## CI/CD与水平扩展部署

项目新增本地可演示的水平扩展部署配置。`Dockerfile`负责构建Next.js应用镜像，`docker-compose.lb.yml`启动三个Web实例、一个独立写回Worker和一个Nginx入口，Nginx配置位于`deploy/nginx/nginx.conf`。多个Web实例共享宿主机PostgreSQL和Redis，默认从`http://localhost:8080`访问，适合在答辩中演示“Nginx负载均衡 + 多应用实例 + Redis入口削峰 + PostgreSQL最终一致”的结构。

新增`/api/health`健康检查接口，返回当前实例标识、数据库连接和Redis连接状态。连续访问该接口可用于验证Nginx入口和应用实例状态。新增`.github/workflows/ci.yml`，流水线包含依赖安装、Prisma校验、数据库迁移、Vitest、ESLint、Next构建、k6脚本检查和Docker镜像构建。压测推荐规模升级为1000名学生抢100个名额，压测入口切换到`http://localhost:8080`，压测报告和一致性摘要会体现水平扩展入口下的容量一致性。

GitHub Actions环境不会复用本机已经生成的`.prisma/client`，因此CI在`prisma validate`后显式执行`pnpm exec prisma generate`，再执行数据库迁移和Vitest集成测试。

k6脚本的目标课程校验放在`setup()`阶段，避免`k6 inspect`这种静态检查在CI中因为没有压测目标文件而失败；真正执行压测时仍会要求先运行`seed-load-test.ts`生成目标课程。

Nginx反向代理必须保留浏览器访问时带端口的`Host`，否则Next.js Server Actions会发现`Origin: localhost:8080`与转发后的`x-forwarded-host: localhost`不一致并拒绝POST请求。当前Nginx配置使用`$http_host`转发`Host`和`X-Forwarded-Host`，保证多实例入口下表单提交、选课按钮和管理员操作都能通过同一外部地址校验。

压测汇总脚本会先使用`artifacts/load-test-target.json`中的开课班ID定位目标课程；如果该ID因重新Seed数据库而失效，脚本会回退到课程号和班号查找当前学期压测课程。若仍找不到，会提示先重新运行`pnpm exec tsx scripts/seed-load-test.ts`，避免直接暴露Prisma查询异常。

## 覆盖率补强记录

根据`artifacts/coverage/coverage-final.json`，本轮优先补强低覆盖服务模块。新增`tests/cache.test.ts`覆盖Redis缓存读取、写入、按学生失效、全量失效和安全失效异常吞掉分支；扩展`tests/schedule.test.ts`覆盖区间边界和星期格式化兜底；扩展`tests/admin.integration.test.ts`覆盖开放期更新、非法时间范围、冻结名单和结果快照。

针对异步选课架构，新增`tests/enrollment-writeback.integration.test.ts`，直接构造Redis预占与Stream任务，覆盖Worker写回中的幂等确认、状态冲突释放和停开课程释放预占。扩展`tests/enrollment.integration.test.ts`覆盖有空位时拒绝候补、未落库预占撤销、退不存在记录、必修课不可退和冻结后不可退。

本轮全量命令`pnpm exec vitest run --coverage --coverage.reporter=text`通过，测试文件7个、用例42个。覆盖率提升到语句89.09%、分支72.05%、函数91.24%、行89.68%；其中`lib/services/enrollment.ts`从73.68%语句覆盖提升到83.15%，`lib/services/enrollment-writeback.ts`提升到83.75%。

## 课程设计报告草稿

新增`course-reports/course-design-report-draft.md`作为纯文本主报告草稿，不生成Word文件。草稿保留既定一级和二级标题，共32个二级标题，采用ICONIX主线组织内容：项目背景和需求、用例模型、领域模型、鲁棒分析、时序交互、架构设计、实现说明、AI辅助开发、系统测试、项目管理和总结反思。Mermaid插图以Markdown代码块形式占位，便于后续渲染为图片后插入Word。草稿中同时预留学生端、管理员端、Allure、覆盖率、k6压测和GitHub Actions截图位置。

报告草稿已按“少表格、多正文”的方向重构。第1章将涉众和功能需求宽表改为分角色、分流程正文；第2章将用例表、鲁棒分析表和追踪矩阵改为用例文本和分析段落；第3章将数据表结构表改为按学生、课程、规则登记三类数据展开；第4章将技术选型和方案比较表改为决策叙述；第7章将测试范围、用例矩阵和问题修复宽表改为分层测试和问题分类正文，仅保留覆盖率和压测指标两张短表。

第1章已根据学校现有教务系统“选课时间一到堵得打不开、缺少候补功能”的真实痛点重写。新版从开选瞬间同步访问、热门课程稀缺、学生反复刷新、数据库热点、结果不透明、候补缺失等角度展开，再推导涉众关注点、学生端和管理员端功能需求、Redis预占、候补递补、可用性、一致性、公平性和可测试性需求。

报告第1章进一步调整为正式表述，删除“我校”，改用“传统教务选课系统”“现有选课系统”等自然称谓，并补充4张简短辅助表：现实痛点与设计回应、涉众关注摘要、功能需求分组、非功能需求摘要。第2章已重写为更完整的系统分析，补充用例边界、核心用例文本、领域对象职责、领域模型图、登记状态机、鲁棒对象分类、关键流程分析和分析成果到设计输入的追踪关系。正文中的内联反引号已清理，Mermaid和目录代码块围栏保留。

报告第3章“系统设计”已深度重写。3.1从入口高峰、Redis短期预占、PostgreSQL最终登记、Nginx多实例和ICONIX对象落地说明总体架构；3.2按学生工作区、管理员工作区、服务层、Worker、运维和测试模块说明功能分工；3.3补充数据实体关系图、核心表职责、登记状态机落表、EligibilityRule、索引和Redis预占映射；3.4补充正常选课、满员候补、退课递补和管理员处理写回积压四个时序图；3.5按性能、一致、恢复、可观测、安全、可修改和可测试展开质量属性。第3章保留简短窄表，避免宽表堆叠。

报告第4章“技术选型与工程决策”已整体重写。4.1按TypeScript、Next.js、React、shadcn/ui、PostgreSQL、Prisma、Redis、Better Auth、Vitest、Allure、k6、Docker、Nginx和GitHub Actions逐层说明用途和选择理由，并补充技术栈分层摘要表。4.2围绕同步写库与Redis预占、Kafka与Redis Stream、Next.js全栈与前后端分离、关系型与文档型数据库、Prisma与手写SQL、自动候补与显式候补、候补表与登记状态机、单实例与Nginx多实例、界面表达方式等关键取舍展开，强调技术选择必须匹配选课高峰、候补递补、名单可信和课程设计证据。

报告第5章“系统实现”已深度重写。5.1按app、components、lib、prisma、scripts、tests、deploy、artifacts和course-reports说明项目结构，强调目录如何对应边界对象、控制对象、实体对象和质量证据；5.2按登录身份、学生Dashboard、规则诊断、正式选课、显式候补、退课递补、课表矩阵、管理员统计、管理员运维、CSV导出、结果API和健康检查说明核心功能实现，并补充核心功能调用链图；5.3分析buildCourseRuleChecks、Redis预占、Worker幂等写回、dropCourse递补事务和一致性运维快照五类关键代码，重点解释竞态风险、幂等控制、事务边界和测试覆盖点。

报告第6章“AI辅助开发实践”已整体重写。6.1说明Codex、ChatGPT和本地文档辅助的使用阶段、用途和频率，强调AI先读取上下文、再提出方案、由开发者确认和验证；6.2按需求澄清、ICONIX建模、架构讨论、代码实现、错误定位、测试证据、界面语言和报告写作展开AI参与内容，并补充AI参与阶段与人工审核点表；6.3从需求展开、设计材料组织、错误定位、测试证据建设、范围膨胀、本地版本约束、语言可读性和开发者最终责任等角度反思AI使用效果与局限。

报告第7章“系统测试”已整体重写。7.1按本地Windows环境、PostgreSQL Docker、Redis Docker、Next.js、Worker、Nginx、Vitest、Allure、k6和artifacts证据目录说明测试环境；7.2从规则判断、容量超卖、候补顺位、异步写回和部署入口五类风险推导单元测试、集成测试、异步测试、构建检查、手动验收和压力测试方案；7.3记录7个测试文件、42个用例、覆盖率89.09%语句、72.05%分支、91.24%函数、89.68%行，以及200名学生抢30名额的k6证据，保留1000抢100作为答辩前推荐压测方案；7.4按工具链版本、数据库/ORM边界、并发一致性、部署和脚本问题分类分析Prisma 7、advisory lock、Redis预占、Nginx转发头、k6 inspect等问题与修复。

报告第8章“项目管理与过程记录”已整体重写。8.1按分析建模、基础实现、业务补强、架构补强、质量收尾五个阶段说明三周计划，并补充项目阶段安排表和甘特图；8.2按需求边界确认、基础系统搭建、规则补强、候补状态机、性能方案演进、工程化证据补强记录开发过程，并说明计划与实际偏差如何通过迭代补强收敛；8.3按需求发散、性能、一致性、依赖版本、测试环境污染、现场演示六类风险说明识别和处理，强调风险处理反过来影响Redis预占、运维工作区、Seed脚本、CI和答辩备用路径等设计。

报告第9章“总结与反思”已整体重写。9.1从Redis预占与Stream、PostgreSQL和Prisma关系建模、Next.js全栈、前端状态组件、Vitest/Allure/k6测试压测总结技术收获；9.2从ICONIX落地、系统边界控制、证据导向、问题管理和项目组织总结工程收获；9.3诚实分析通知缺失、培养方案规则简化、权限模型较粗、运维能力课程设计化、压测环境受限、外部系统集成模拟、可访问性和移动端体验不足，并给出短中长期改进路线；9.4围绕从页面可点击到工程证据、建模控制复杂度、AI时代开发者责任、报告与代码互证、软件工程专业能力形成课程设计体会。

报告草稿已补齐图表规范：所有表格标题放在表格上方，所有Mermaid图和截图占位标题放在图下方，正文均自然引用对应编号。第7章的Allure、覆盖率、k6压测和压测后一致性截图占位已改为`图7.1`到`图7.4`并配套正文说明。当前扫描结果显示每个`表x.x`和`图x.x`编号至少出现两次，说明标题和正文引用均已存在；正文中也清理了不符合风格要求的转折表达。

报告草稿已再次通读精简，删除了一批多余解释和自解释句，将显式转折表达改为并列、递进或直接断句。当前报告正文的高风险句式扫描无命中，图表编号扫描仍显示每个表题和图题都有正文引用。

后续报告写作要避免把项目描述成对外部规则或写作材料的回应。正文应直接讲业务问题、设计取舍、实现证据和测试结果，不写对照式自我说明。

报告草稿已继续清理“先排除，再转向事实”的隐性句式。典型改法是直接陈述系统主线、测试观察对象和设计取舍，减少先声明非目标再说明目标的写法。当前针对高风险句式和显式转折的扫描均无命中。保留“容量不超卖、必修课不能退”等业务约束表达。

报告第1章的图1.1已从用例图调整为PlantUML系统上下文与边界图，展示学生、管理员、外部教务主系统与在线选课系统的关系，并把Redis、PostgreSQL和写回Worker作为系统内部支撑结构呈现。第2章图2.1也已改为PlantUML正式用例模型图，保留学生、管理员、写回Worker和外部教务主系统四类参与者，避免第1章和第2章重复表达同一组用例。

报告第2章图2.2已从Mermaid ER图改为PlantUML领域模型类图，保留学生档案、学院、专业、学期、课程、开课班、选课登记、资格规则、上课时间、操作日志和Redis临时预占状态，并标出开课班与登记、时间、资格和预占之间的核心关联。

报告草稿中保留的Mermaid图已全部补充相邻PlantUML版本。图2.3、图2.4、图3.1、图3.2、图3.3、图3.4、图3.5、图3.6、图3.7、图5.2和图8.1均可用Mermaid或PlantUML生成同一图意，便于后续按Word排版工具选择渲染方式。

报告草稿已做一轮重复内容检查和精修。第1章删去过早展开的Redis预占、候补状态机和ICONIX对象细节，改为从现实痛点归纳学生反馈、管理员治理和运行支撑三层能力；第5章Redis关键代码分析改为强调模块边界、键名约束、返回值归一和TTL策略，减少与架构时序图重复；第8章开发过程记录改为突出迭代顺序、问题推动和证据形成；第9章课程设计体会减少功能清单式回顾，转向抽象经验和证据链总结。

报告第5章图5.1已由普通文本目录树改为Mermaid `treeView-beta`，并保留相邻PlantUML mindmap版本。图5.1现在展示app、components、lib、prisma、scripts、tests、deploy、artifacts和course-reports的主要层次，符合后续所有Mermaid图旁边补PlantUML代码块的约定。

报告第6章“AI辅助开发实践”已按案例剖析重构。新版6.1强调Codex、ChatGPT和本地文档资料的使用场景、产出形式和人工控制点；6.2用系统增强、ICONIX建模、高并发与调试、测试证据四个真实案例说明AI如何辅助形成候选方案和排查方向；6.3总结效率提升、范围扩大、本地版本约束、语言术语和人工责任，弱化“AI直接实现代码”的表述，突出开发者的边界判断、命令验证和最终验收。

报告第5.3节“关键代码分析”已从五类实现概述改为三段真实代码节选加设计分析。三段分别覆盖规则诊断构造器、Redis正式名额预占Lua脚本、退课递补事务；代码块不加标题和编号，只由正文自然引出。表5.2改为“关键代码与设计思想”，行内容对应规则诊断、Redis预占和退课递补三类核心风险。
