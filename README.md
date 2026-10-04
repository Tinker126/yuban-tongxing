# 语伴童行

面向小学3–6年级的英语口语练习网站。Node.js + Express 提供学生页面、DeepSeek代理、学生账号、学习历史和管理员学习数据后台。学生账号、学生与管理员登录会话、正式练习和逐轮对话均保存在 PostgreSQL。语音可由浏览器识别，或临时上传至后端调用腾讯云 ASR；网站只持久保存文字，不保存录音文件。

## 本地启动

需要 Node.js 22.16+（建议 Node.js 24 LTS）。在项目根目录运行：

```bash
npm ci
npm run setup
```

初始化程序创建本地 `.env` 并生成 `SESSION_SECRET`。在 `.env` 配置 DeepSeek Key 和 PostgreSQL `DATABASE_URL`。本地管理员密码以 scrypt 哈希保存于 `.env` 的 `ADMIN_PASSWORD_HASH`；可用 `npm run admin:password` 在本机交互终端中无回显地设置密码，只写入哈希。随后运行：

```bash
npm run db:check
npm run db:migrate
npm run admin:provision
npm start
```

管理员用户名由 `.env` 中的 `ADMIN_USERNAME` 配置（默认 `123456789`），姓名为“管理员”。首次或重新设置时，可在交互式 SSH 终端运行 `npm run admin:setup`；账号明文可见，密码连续输入两次且不回显，数据库仅保存 scrypt 哈希，脚本会验证登录和后台权限。分步工具 `admin:password` 与 `admin:provision` 仍可用。公开注册仍只能创建学生。不要把真实 `.env`、数据库连接串、DeepSeek Key 或明文管理员密码写入 Git、`.env.example`、前端或静态目录。`.env` 已被 Git 忽略。

打开 `http://localhost:3101`，管理员入口为 `http://localhost:3101/admin/login`。必须使用与 `APP_ORIGIN` 完全一致的来源；`localhost` 与 `127.0.0.1` 是不同来源。不要双击HTML，也不要使用 `file://`。Windows PowerShell若禁止执行 `npm.ps1`，将命令中的 `npm` 改为 `npm.cmd`，无需降低系统执行策略。

完整公网部署步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)，接口与数据字典见 [API.md](API.md)，验证范围见 [TESTING.md](TESTING.md)。

## 功能

- 3–6年级指定话题、响应式学生页面、卡通数字人状态动画。
- 浏览器 `SpeechRecognition` 与 `MediaRecorder → 服务端 STT` 双路径英语识别；配置服务端识别后，Android 优先使用录音路径，其他设备在浏览器识别失败时自动切换。TTS 使用浏览器语音播放能力。
- DeepSeek `deepseek-flash` 由后端代理调用，API Key 只在服务端环境变量中。
- 学生注册、登录、退出和 HttpOnly Cookie Session；普通注册始终由服务端设置 `role=student`。
- 学生自己的 `/history` 练习历史和单次对话详情。
- 自由聊天与六个情景练习（认识新朋友、校园交流、餐厅点餐、商店购物、问路、生日聚会）；情景提示按年级控制角色、任务和回复长度，任务进度保存到练习记录。
- 管理员 `/admin/login`、`/admin` 学习数据后台：练习统计、学生列表和详情、完整多轮对话。管理员身份由数据库 `role=admin` 校验，后台统计读取真实 PostgreSQL 数据。
- 管理员用户密码以 scrypt 哈希保存；管理员登录会话以随机 token 的 SHA-256 哈希写入 `auth_sessions`，Cookie 为 HttpOnly、SameSite=Strict，生产HTTPS时带 Secure。
- 每轮真实转写、AI回复、点评和（情景模式下）任务进度写入 PostgreSQL；未实现真实发音评测，不显示或伪造发音、流利度、准确度分数。
- 学生账号、登录会话、正式练习和逐轮记录均使用 PostgreSQL；旧版 `/api/saveChat` 本地 JSON 归档仅供开发兼容，生产环境停用；没有录音文件存储。

## 语音与隐私边界

“Web Speech API”不等于完全离线识别，普通浏览器识别可能使用浏览器厂商的在线服务。可靠录音路径会临时上传音频，经后端内存转码后提交腾讯云 ASR 英语识别，返回文字后释放音频；不会创建音频文件、数据库音频字段或公开下载链接。第三方音频处理受其服务条款约束，不能把网站的“不落盘”理解为对第三方留存的保证。部署与凭据配置见 [SPEECH_STT.md](SPEECH_STT.md)。

TTS 优先使用可用的英语声音，没有特定声音时回退到浏览器默认声音。自动播放未获允许时提示点击“再听一遍”，不会阻塞下一次语音输入。不支持 TTS 的浏览器可阅读文字回复。

公网必须使用HTTPS，浏览器通常会在公网HTTP下限制麦克风。`http://localhost`可用于本机开发；其他设备访问局域网HTTP也不能保证麦克风可用。`file://`不受支持。

教材范围通过提示词约束，不能保证模型绝不超纲。用于正式教学研究前，应由教师校对回复、教材词汇和句型。语音识别置信度不是发音分数。用户直接关闭页面留下的练习可能保持 `active`，自动清理待后续实现。

## 文件结构

```text
yuban-tongxing/
├── package.json / package-lock.json
├── .env.example / .gitignore / server.js
├── src/                 # Express、认证、管理员和练习API、数据库
├── db/migrations/       # PostgreSQL SQL migrations
├── public/              # 学生页面、登录页、历史页、管理员前端脚本
├── views/admin.html     # 后端保护的管理员页面
├── scripts/             # 数据库、管理员配置和集成测试命令
└── test/                # Node内置自动化测试
```

## 测试

```bash
npm test
npm run test:auth
npm run test:practice
npm run db:check
npm run test:admin
```

`npm test` 使用内存替身验证权限和路由；数据库集成测试会在配置的 PostgreSQL 中创建并清理临时测试账号。`test:admin` 只读取已存在的真实五轮练习记录，并临时创建、随后删除管理员会话，不修改学习记录。
