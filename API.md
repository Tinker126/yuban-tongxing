# 接口与数据字典

所有接口与网页同源，根路径部署。POST只接受JSON，必须带 `Origin`（与APP_ORIGIN一致）和 `X-Requested-With: ybtc`；浏览器正常调用时Origin自动携带。未开放跨域CORS。服务器不接收音频、multipart文件或录音Blob。

## 完整练习调用顺序

1. `GET /api/topics` → `{topics, starters, maxRounds:30}`。
2. 登录学生后，`POST /api/practice/sessions` 请求 `{grade:3,topic:"问候与介绍",consent:true}`，服务器从HttpOnly Cookie查找学生身份并创建数据库记录，响应 `{sessionId}`。客户端提交的 `student_id` 一律不使用。
3. `POST /api/startSession` 请求 `{grade,topic,consent,practiceSessionId}`；服务器再次检查该数据库练习属于当前登录学生，然后返回 `{sessionId,startTime,sessionToken,opening}`。签名凭证绑定数据库练习和学生身份。
4. `POST /api/chat`，请求示例：

```json
{
  "sessionToken": "上一步返回的完整会话签名",
  "grade": 3,
  "topic": "问候与介绍",
  "text": "Hello! I am fine.",
  "history": [],
  "inputMode": "speech",
  "confidence": 0.86
}
```

响应：

```json
{
  "reply": "Hello! What do you like?",
  "comment": {"highlight":"你用完整的句子回答了。","suggestion":"试试再说一句自己的喜好。"},
  "receipt": "后端签名的完整本轮记录",
  "time": "2026-09-28T03:00:00.000Z"
}
```

此处只是接口结构示例，不是实际模型效果证据。后续请求的 `history` 按顺序包含此前每轮 `receipt`。receipt包含本轮转写、回答、点评、输入方式、置信度、时间和上一轮摘要，并由HMAC-SHA256签名；它不是加密数据。后端验证链和会话归属后恢复完整对话，构造system/user/assistant消息，防止浏览器伪造AI回复或插入system角色。不要把sessionToken或receipt写入日志。

`inputMode`仅为 `speech` 或 `text`；文字模式置信度必须为null；语音置信度为0–1或null，严格保存浏览器原始值。重试同一句不自动创建轮次；只有成功返回的receipt进入前端历史。

5. 每次 `/api/chat` 成功返回后，页面将 `{turnNumber,receipt}` 提交到 `POST /api/practice/sessions/:sessionId/turns`。服务端检查当前登录学生、练习归属和DeepSeek结果签名，再从签名回执写入真实转写、回复、点评、输入方式和置信度；唯一轮次约束支持安全重试，不接受客户端自报学生ID或未经签名的对话文本。
6. `PATCH /api/practice/sessions/:sessionId/complete` 结束练习。结束时间和时长由数据库服务器时钟计算，轮数取数据库实际记录数。
7. `GET /api/practice/sessions` 返回当前登录学生的练习历史，从新到旧排序。可用 `limit`（默认20，范围1–50）、`offset`（默认0）、`status`、`topic`、`grade` 筛选。响应包括 `sessions` 和 `{limit,offset,total,hasMore}` 分页信息；不会读取客户端提供的学生ID。
8. `GET /api/practice/sessions/:sessionId` 只向所属学生返回该练习及按轮次排序的对话详情；其他学生得到404。历史页面为 `/history`，单次详情为 `/history/:sessionId`，页面本身不缓存，数据仅由登录后API返回。

## 情景练习接口

学生主页保留“自由聊天”，并增加“情景练习”。情景列表为 `GET /api/scenarios?grade=3`（年级3–6），返回六个场景的年级版本：`meet-a-friend`、`school-talk`、`restaurant-order`、`shop-for-item`、`ask-directions`、`birthday-party`。每项包含角色、目标、开场语、推荐表达、任务清单、难度和年级回复长度要求。

情景需要登录后开始。`POST /api/practice/sessions` 请求 `{grade,topic,sceneId,consent:true}`，其中 `topic` 必须是该场景的标题；服务端从登录Cookie取得学生ID，并把 `scene_id`、`scene_title` 和初始任务进度写入同一条 `practice_sessions`。`POST /api/scenarios/:sceneId/start` 请求 `{practiceSessionId}`，校验该练习归当前学生所有后返回开场语和签名的情景会话凭证。

每轮调用 `POST /api/scenarios/chat`，输入方式和签名历史与自由聊天类似，返回 `{reply,comment,progress,completed,completedConditions,remainingConditions,receipt,time}`。情景专用提示词明确年级、角色、目标、表达、已完成/剩余任务和句长。完成状态根据任务清单计算，不根据轮数计算。前端仍通过 `POST /api/practice/sessions/:sessionId/turns` 提交本轮签名回执；该接口在同一事务中保存真实转写、AI回复、点评和任务进度。重复提交保持幂等。情景练习仍通过 `PATCH /api/practice/sessions/:sessionId/complete` 结束，响应包含完成任务及从真实学生转写中匹配到的目标表达。情景名称同时出现在学生 history 与管理员练习详情API中。

Migration `003_scenario_practice` 只给 `practice_sessions` 增加可空情景快照字段和默认空任务进度，旧自由聊天记录保持原样。暂不保存音频，也不生成发音或流利度评分。

旧版兼容接口 `POST /api/saveChat` 仅在非生产环境写入本地 `userData.json`；生产环境返回 HTTP 410。当前学生页面不调用该接口，正式练习的每轮记录均通过 `/api/practice/sessions/:sessionId/turns` 写入 PostgreSQL。

首次成功：HTTP 201 `{ok:true,duplicate:false,sessionId,endTime}`；完全相同的重复提交HTTP 200且 `duplicate:true`，返回原始结束时间；同一ID不同内容HTTP 409，禁止覆盖。失败不清空前端会话。会话凭证24小时后不能继续或保存。

## 学生认证接口

学生账号、登录会话及正式练习记录使用托管 PostgreSQL。注册页面为 `/register`，登录页面为 `/login`；登录后进入现有练习主页。正式练习记录API要求学生登录，管理员后台只读取数据库中真实存在的学生及练习记录。

| 接口 | 请求/响应 | 说明 |
|---|---|---|
| POST /api/auth/register | `{username,name,password,grade}` → HTTP 201 `{id,username,name,grade,role}` | 账号3–32位字母/数字/下划线；年级3–6；密码8–128字符；服务端固定 `role=student`，重复账号409 |
| POST /api/auth/login | `{username,password}` → `{id,username,name,grade,role}` | 错误账号和密码统一返回401；成功创建数据库会话并设置Cookie |
| GET /api/auth/me | `{id,username,name,grade,role}`；未登录401 | 仅查询当前Cookie对应且未过期的数据库会话 |
| POST /api/auth/logout | `{}` → `{ok:true}` | 删除数据库会话并清除Cookie |

## 学生学习历史接口

| 接口 | 请求/响应 | 鉴权 |
|---|---|---|
| GET /api/practice/sessions | `?limit=20&offset=0&status=completed&topic=问候与介绍&grade=3` → `{sessions:[{id,topic,sceneId,sceneTitle,scenarioProgress,grade,startedAt,endedAt,durationSeconds,turnCount,status}],pagination:{limit,offset,total,hasMore}}` | 学生Cookie；只查询当前学生 |
| GET /api/practice/sessions/:sessionId | `{session:{id,topic,sceneId,sceneTitle,scenarioProgress,grade,startedAt,endedAt,durationSeconds,turnCount,status},turns:[{turnNumber,studentText,aiReply,feedback,inputMode,recognitionConfidence,createdAt}]}` | 学生Cookie且必须为练习所有者；否则404 |

列表筛选仅接受已知练习状态、教材话题/情景标题及3–6年级。limit最大50，offset最大100000。情景字段仅在情景练习记录中出现；旧自由聊天行保持空值。列表和详情均不缓存；匿名请求返回401。学生历史页在 `/history`，详情页在 `/history/:sessionId`。

密码使用加盐 scrypt 哈希，数据库只保存随机会话令牌的 SHA-256 摘要。学生Cookie为 HttpOnly、SameSite=Lax、7天有效；生产HTTPS环境增加 Secure。前端不保存密码或权限到 localStorage。所有POST沿用全站的同源、`X-Requested-With` 和JSON校验；认证接口另有限流。测试云数据库可运行 `npm run test:auth`，它会创建并清理随机测试学生。

## 管理员接口

| 接口 | 请求/响应 | 鉴权 |
|---|---|---|
| POST /api/admin/login | `{username,password}` → `{ok:true,user:{id,username,name,role}}` | 数据库账号 `role=admin`；成功时写入 `auth_sessions` 并设置8小时Cookie |
| GET /api/admin/me | `{id,username,name}` | 管理员Cookie；匿名401，学生403 |
| POST /api/admin/logout | `{}` → `{ok:true}`；撤销数据库Session并清除Cookie | 管理员Cookie及同源检查 |
| GET /api/admin/summary | 学生总数、按中国标准时间统计的今日练习人数/次数、累计次数/时长、最近20次练习 | 管理员Cookie |
| GET /api/admin/students | `{limit,offset}` → 学生列表及练习统计；默认20条，最多50条 | 管理员Cookie |
| GET /api/admin/students/:studentId | 学生信息、累计次数/时长/轮数和该学生练习列表；默认50条，最多100条 | 管理员Cookie |
| GET /api/admin/practice/sessions/:sessionId | 单次练习基本信息及按轮次排序的 `studentText`、`aiReply`、`feedback` | 管理员Cookie |
| GET /health、GET /api/health | `{ok:true}` | 无；仅进程健康，不检查数据库或上游服务 |

管理员固定账号 `123456789`，姓名“管理员”，角色由数据库 `role=admin` 决定；管理员密码为 scrypt 哈希并与学生密码格式相同。`npm run admin:provision` 从本地 `.env` 读取 `ADMIN_PASSWORD_HASH`，创建或更新该账号，不读取明文密码；`npm run admin:password` 可在交互终端中无回显地设置新密码，只把哈希写入本地 `.env`。管理员生产Cookie为 HttpOnly、Secure、SameSite=Strict，数据库只保存随机令牌的SHA-256哈希；Session在 PostgreSQL 中，服务器重启后仍有效，直到过期或退出。学生Cookie仍使用独立名称；管理员API的匿名请求返回401，学生请求返回403。管理员页面和数据接口均 `Cache-Control: no-store`。错误统一为 `{error:"面向用户的提示"}`。主要状态码：400格式、401未登录/密码错误、403角色不足或来源错误、404资源不存在、409账号冲突/保存冲突、413过大、415非JSON、429限流、502上游失败、503暂不可用、507旧版文件容量满。

旧版 JSON 归档的 `GET /api/getAllData` 和 `GET /api/exportCsv` 在非生产环境供管理员兼容使用；生产环境未启用本地 JSON store，因此这些旧接口返回服务不可用。学生 PostgreSQL 学习记录由上表所列管理员API读取；未实现发音评分，不返回或伪造 pronunciation、fluency、accuracy 分数。

## userData.json

根对象为数组，初始值 `[]`。一条记录字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| schemaVersion | number | 当前1 |
| sessionId | string | 服务端UUID，不含学生身份 |
| startTime | ISO string | 服务端建立会话的UTC时间 |
| endTime | ISO string | 服务端第一次持久化成功流程中的结束时间 |
| grade | number | 3/4/5/6 |
| topic | string | 对应年级的话题 |
| studentTexts | string[] | 逐轮学生语音转写或文字输入 |
| aiReplies | string[] | 逐轮英文回答 |
| aiComments | object[] | 逐轮highlight、suggestion |
| rounds | number | 已成功完成的学生+AI配对数，不含开场语 |
| recognitionConfidences | (number/null)[] | 与轮次对齐的浏览器置信度 |
| turns | object[] | 每轮student/reply/comment/confidence/inputMode/time |
| contentHash | string | 已保存内容SHA256，用于幂等比较 |
| consentVersion | string | 展示说明的版本；不是单独的监护人授权证据 |

不保存音频、设备指纹、访客IP或学生真实账户。内存限流会短时使用请求IP，未写入userData.json。服务器平台独立日志的配置由运营方管理。

## CSV语义

一轮一行，重复会话ID以方便按会话分组；**CSV行数不是会话数**，会话数应对ID去重。包含会话起止UTC时间、年级、话题、总轮次、当前轮序号、输入方式、学生文字、AI英文、两个点评字段、置信度、逐轮时间。空置信度导出为空单元格；0保留为0，不解释为零分。文本按CSV双引号规则转义，并对可能被Excel解释为公式的起始字符添加单引号；中文文件含UTF-8 BOM，适合Excel直接打开。CSV本身没有访问控制，导出后的本地文件应由管理员妥善保管。

## 安全与容量限制

全站API每IP每分钟180次；新建会话每分钟20次；聊天每分钟30次；登录每15分钟10次。学校共用公网IP时会共享限流，需要结合真实试测人数调整 `src/app.js` 中的值。匿名开放AI接口仍可能被自动化滥用，当前限制及日预算只降低风险，不声称彻底防刷。使用单进程PM2并监测API账户额度。请求日志不输出正文、口令、签名或上游响应。
