# 语伴童行：生产部署与运维

## Render 托管服务

仓库根目录的 `render.yaml` 定义单实例 Node Web Service，构建命令为 `npm ci`，启动命令为 `npm start`，健康检查路径为 `/health`。Blueprint 使用 Free 实例供首次验证；[Render 明确不建议将 Free 实例用于生产应用](https://render.com/docs/free)。连接自己的 Git 仓库和 Render 账号后才能创建服务；此仓库没有附带真实账号、域名或密钥。

Render 为 Web Service 分配 `https://...onrender.com` 地址，并在边缘终止 HTTPS。配置 `APP_ORIGIN` 为实际分配的完整 HTTPS 来源，不能添加路径；缺失或使用 HTTP 时服务会拒绝启动。如果创建 Blueprint 时还不知道精确地址，创建服务后立即在 Render Environment 页面填写 `APP_ORIGIN` 并重新部署。Blueprint 中的 `APP_ORIGIN`、`SESSION_SECRET`、`DATABASE_URL` 和 `DEEPSEEK_API_KEY` 均需在 Render 中填写，仓库不保存这些值。`SESSION_SECRET` 至少 48 个字符；数据库连接指向已迁移的 Neon PostgreSQL。首次使用前，在受控本机环境运行 `npm run db:check`、`npm run db:migrate`、`npm run admin:provision`，不要在 Git 中放管理员密码或哈希。

Render 提供的 `PORT` 会被直接使用，未提供时默认 3101；Blueprint 设置 `HOST=0.0.0.0` 供 Render 代理访问。Render Blueprint 设置 `TRUST_PROXY_HOPS=1`：Express 仅信任应用前面的一跳 Render 代理，以读取其转发的客户端 IP 和原始 HTTPS 协议；不信任任意转发链。`GET /health` 返回 `200 {"ok":true}`，表示 Web 进程可响应，不验证数据库或 DeepSeek。

学生账号、学生及管理员会话、正式练习与逐轮对话存入 Neon，服务重启后仍由数据库保存。生产环境不初始化或使用 `userData.json`；旧版 `/api/saveChat` 在生产环境返回 410，旧 JSON 管理接口也不可用。Render Free 的本地文件会在休眠、重启或重新部署后丢失，因此不用于保存正式学生记录。当前限流和每日 AI 预算在进程内存中，保持单实例。下文是另一种自管 Linux 云服务器与本机 Nginx 的操作示例。

## 1. 部署结果与准备条件

项目运行在云服务器上后，学生用外网手机、平板和电脑访问HTTPS域名即可使用；你的个人电脑可以关机。服务器需要持续开机、联网，并能访问 `https://api.deepseek.com`。需要准备：Linux云服务器（以下命令以Ubuntu 24.04为例）、域名及DNS管理权限、可用DeepSeek API Key、SSH管理权限。准备Node.js 22.16或更高的受支持版本，建议24 LTS；磁盘需持久化，不能使用每次发布清空文件的无状态托管服务。

本交付提供完整可部署代码，未代购云资源、绑定真实域名、签发证书或部署到用户的真实服务器。

> 重要：公网HTTP通常会被浏览器限制麦克风，必须配置Nginx反向代理和有效HTTPS证书。局域网 `http://192.168.x.x` / `http://10.x.x.x` 也不能保证麦克风可用。`http://localhost`常可用于本机开发，这个例外不能推广到其他设备。不要通过 `file://` 打开网页：本项目依赖HTTP/HTTPS接口和同源校验，必须启动服务。

## 2. 服务器与域名

将以下示例的 `practice.example.com` 全部替换为实际域名。设置域名A记录指向服务器公网IPv4。若没有配置好IPv6，不要添加不可用的AAAA记录。云安全组放行80、443以及仅管理所需的SSH端口；无需对公网开放3101。

以有sudo权限的管理用户安装系统组件：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx unzip ca-certificates
```

从Node.js官方发行渠道安装Node.js 24 LTS（或使用你信任的版本管理器），然后确认：

```bash
node --version
npm --version
```

版本应为24.x，最低为22.16。云服务器镜像自带的Node可能过旧。不要仅凭 `apt install nodejs` 假定版本满足要求。

创建专用、非root运行用户和应用/数据目录：

```bash
sudo adduser --disabled-password --gecos "" yuban
sudo install -d -o yuban -g yuban -m 750 /opt/yuban-tongxing
sudo install -d -o yuban -g yuban -m 700 /var/lib/yuban-tongxing
```

将交付ZIP上传到服务器管理用户的目录，解压后把 **项目目录内部全部文件，包括 `.env.example` 和 `.gitignore`** 放进 `/opt/yuban-tongxing`。包内的 `data/userData.json` 是空数组样例，生产数据将在 `/var/lib/yuban-tongxing`，避免更新代码时覆盖。

```bash
sudo chown -R yuban:yuban /opt/yuban-tongxing
sudo -iu yuban
cd /opt/yuban-tongxing
npm ci --omit=dev
npm run setup
```

初始化程序只生成服务端 `SESSION_SECRET`，不会显示或写入管理员明文密码。管理员密码通过交互命令无回显输入，scrypt 哈希仅保存在服务器 `.env` 中。`.env`只在服务器上保存，不发给学生、不提交到Git。

## 3. 配置环境变量

以 `yuban` 用户编辑 `/opt/yuban-tongxing/.env`：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3101
APP_ORIGIN=https://practice.example.com
TRUST_PROXY=1
DEEPSEEK_API_KEY=替换为你的真实密钥
DEEPSEEK_MODEL=deepseek-flash
DATABASE_URL=Neon提供的TLS PostgreSQL连接串
ADMIN_PASSWORD_HASH=本地交互设置后保存的scrypt哈希
SESSION_SECRET=保留初始化生成的随机签名密钥
DATA_FILE=/var/lib/yuban-tongxing/userData.json
MAX_RECORDS=20000
MAX_DATA_MB=100
DAILY_AI_LIMIT=1000
```

不要把明文管理员密码写入配置。配置文件权限：

```bash
chmod 600 .env
```

说明：

- `DATABASE_URL`来自托管PostgreSQL平台，必须允许该Node服务器通过TLS连接；不要提交到Git。
- 迁移数据库后运行 `npm run admin:password`，在本机终端无回显输入管理员密码，再运行 `npm run admin:provision` 建立固定管理员账号 `123456789`。
- 首次部署配置完 `.env` 后，在运行Node服务前执行 `npm run db:check`、`npm run db:migrate` 和 `npm run admin:provision`。

- `APP_ORIGIN`必须与访问网址完全一致，仅含协议、域名和必要端口，不含子路径。项目部署在域名根目录，不是 `/english/` 子路径。
- `TRUST_PROXY=1`只信任loopback代理地址，配合绑定127.0.0.1和本文Nginx配置使用；不要把Node直接暴露公网。跨机器反向代理需要另行调整可信代理，不能盲目信任所有转发头。
- API Key仅在Node后端请求头中使用。静态目录仅为 `public/`，不存在把整个项目作为静态文件目录的配置。
- `DAILY_AI_LIMIT`是UTC日内、单进程内的请求预算上限，失败的上游调用也计数；重启会重置。不是账户级永久额度账本，还应在服务商侧设置预算和余额提醒。
- 无录音上传接口；仅接受JSON文本，体积上限512KB，每次最多600字符、每会话30轮。

## 4. 用PM2后台常驻

如果Node是系统安装的，退出 `yuban` shell后由sudo管理员安装PM2：

```bash
exit
sudo npm install -g pm2
sudo -iu yuban
cd /opt/yuban-tongxing
pm2 start ecosystem.config.cjs
pm2 status
pm2 save
pm2 startup
```

执行 `pm2 startup` **实际打印的sudo命令**（需要返回sudo管理员终端执行），它会依据服务器Node路径创建正确的开机服务；不要照抄别的机器的PATH。然后回到 `yuban` 用户再次 `pm2 save`。若用nvm等用户级Node安装，PM2也在该用户环境安装，并使用对应的 `pm2 startup` 输出。

```bash
curl http://127.0.0.1:3101/health
pm2 logs yuban-tongxing --lines 50
```

健康接口应返回 `{"ok":true}`。它只说明Web进程存活，**不代表DeepSeek密钥、余额或存储写入一定正常**。正式练习仍需人工验收。

当前试测建议单实例fork运行，**不要执行 `pm2 scale`、不要使用集群模式，也不要同时运行 `npm start` 和PM2连接同一生产数据文件**。学生及管理员会话存入PostgreSQL；限流和每日AI预算仍在单进程内存中，旧版匿名 `userData.json` 也由本机文件保存，因此多实例部署前还需另行设计这些共享状态。

终端关闭或SSH断开后，PM2仍会运行；服务器重启后的自动恢复依赖上面startup+save两步。服务器关机或停机则网站不可访问。

## 5. 配置Nginx与HTTPS证书

用sudo管理员编辑初始HTTP站点：

```bash
sudo cp /opt/yuban-tongxing/deploy/nginx-http.conf /etc/nginx/sites-available/yuban-tongxing
sudo nano /etc/nginx/sites-available/yuban-tongxing
sudo ln -s /etc/nginx/sites-available/yuban-tongxing /etc/nginx/sites-enabled/yuban-tongxing
sudo nginx -t
sudo systemctl reload nginx
```

把文件中域名替换为自己的域名。若符号链接已存在，不要重复创建。初始HTTP配置只用于申请证书，在此阶段不要向学生开放练习。

域名解析和80端口可达后申请证书：

```bash
sudo certbot --nginx -d practice.example.com
```

按Certbot提示填写运维邮箱并处理条款。申请成功后，使用最终HTTPS配置（先确认文件中域名和证书路径与实际一致）：

```bash
sudo cp /opt/yuban-tongxing/deploy/nginx-https.conf /etc/nginx/sites-available/yuban-tongxing
sudo nano /etc/nginx/sites-available/yuban-tongxing
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
systemctl list-timers --all | grep certbot
```

域名和证书路径必须同时替换；`nginx -t`成功后才能reload。确认系统存在证书续期timer；若发行方式不同，依据Certbot安装方式配置自动续期。以后访问 `https://practice.example.com`，HTTP自动跳转HTTPS。

Nginx不能设置 `root /opt/yuban-tongxing` 或暴露数据目录。模板关闭访问日志以减少访客IP留存；错误日志仍可能含网络诊断元数据，应由运维按研究要求设置保留期，禁止加入请求正文日志。云厂商的网络日志属于其独立配置。

## 6. 管理员账号和密码维护

管理员账号固定为 `123456789`，认证角色保存在 PostgreSQL 的 `users.role`。修改密码时，在服务器项目目录运行：

```bash
npm run admin:password
npm run admin:provision
```

密码输入不回显，程序只把 scrypt 哈希写入本地 `.env`；随后将新哈希同步到数据库。不要将明文密码放入命令参数、shell历史、README、前端或Git。然后以运行PM2的 `yuban` 用户执行：

```bash
pm2 restart yuban-tongxing --update-env
pm2 save
```

密码更新后，已有管理员Cookie不会自动失效；需要退出管理员账号。签名密钥未变且未过24小时的学生练习可继续；不要无故更换 `SESSION_SECRET`，否则当前未保存的练习凭证会失效。密钥泄露时需要轮换，但应先通知正在练习的用户。

管理员会话存入 PostgreSQL `auth_sessions`，Cookie使用HttpOnly、SameSite=Strict并在生产环境加Secure。登录有效8小时，点击退出即失效；重启服务不会清除有效Session。管理员后台从 PostgreSQL 读取学生列表、练习统计和完整逐轮对话，所有管理员API均检查 `role=admin`。

## 7. 数据文件、备份与升级

生产数据文件是 `/var/lib/yuban-tongxing/userData.json`，编码UTF-8。不要放进 `public`，不要放公开网盘，不要在服务器运行时手工改写。每次保存采用进程内队列、文件锁、临时文件同步写盘、同目录原子替换；相同会话重复保存不会新增记录，不同内容覆盖会被拒绝。文件损坏时拒绝启动/读取，不会自动清空覆盖。

该文件是单机JSON存储，整文件读取/重写，会随数据量增长而变慢。默认上限20000条或100MB，以先到者为准。到达上限时返回错误并提示归档。研究试测宜保持规模有限，及时备份；不要通过无限增大阈值替代容量规划。

一次备份（由 `yuban` 用户执行）：

```bash
install -d -m 700 /var/lib/yuban-tongxing/backups
cp /var/lib/yuban-tongxing/userData.json /var/lib/yuban-tongxing/backups/userData-$(date +%Y%m%d-%H%M%S).json
chmod 600 /var/lib/yuban-tongxing/backups/*.json
```

原子替换使拷贝得到的是一个已提交版本；若要求严格时间点备份，请暂停学生练习后停止PM2再备份。文件系统原子性不代替云盘快照和异机备份。管理员可根据研究保留期限配置定期备份任务与加密异机存储，且定期演练恢复。

恢复步骤：停止服务、保留当前文件、检查备份JSON可解析且为会话数组、将备份复制到生产路径、确认权限600与用户yuban、重新启动并检查后台。不得在程序运行时覆盖文件。所有删除或归档须按研究方案执行，后台没有对学生开放删除接口。

升级代码时：先安排练习暂停并备份 `.env` 与生产数据；保留旧版本代码；只替换应用源码；执行 `npm ci --omit=dev` 和 `npm test`；再执行 `pm2 restart yuban-tongxing --update-env`。**不要覆盖 `/var/lib/yuban-tongxing/userData.json`，不要重新生成 `.env`。** 如升级失败，恢复旧代码和对应锁文件，保留数据不变。

## 8. 公网上线验收

1. 个人电脑关机后，用另一设备的蜂窝网络打开HTTPS域名，确认网站仍可用。
2. 未登录直接访问 `/admin` 应跳转登录页；`/api/getAllData` 和 `/api/exportCsv` 应返回401。
3. 访问 `/.env`、`/data/userData.json`、`/userData.json`、`/src/config.js` 应被拒绝或404。
4. 在支持设备端识别的浏览器安装英语识别包，允许麦克风，确认“正在倾听→正在说话→空闲”；测试拒绝权限、未说话、停止收音等情况。
5. 确认浏览器的请求只含JSON文本，没有Blob、录音或音频上传；本代码没有MediaRecorder或音频上传端点。检查浏览器本地识别支持，不能使用云识别兼容模式替换。
6. 测试真实DeepSeek回答、超时/断网提示与重试；不会把错误算成已完成轮次。检查API Key不在页面源代码、静态JS、浏览器响应或CSV中。
7. 两台外网设备分别完成并保存，管理员后台应同时看到两条学生练习记录，并可展开逐轮转写、AI回复和点评。
8. 匿名请求管理员API应为401，学生请求应为403，管理员请求应为200。退出管理员登录后原Cookie请求应失败；重启PM2后有效PostgreSQL登录会话仍可使用。
9. 在目标手机/平板/电脑分别验证；不支持本地识别的设备应提示文字模式，不应调用远程语音识别。

## 9. 常见问题

| 现象 | 检查方法 |
|---|---|
| 点击发送提示来源不正确 | `.env` 的APP_ORIGIN是否与地址栏一致？是否忘记重启？是否使用了IP代替域名？ |
| 公网麦克风不可用 | 必须HTTPS且证书有效；浏览器需要设备端SpeechRecognition与en-US包；还需系统/网站麦克风权限。微信等内置浏览器可能不支持，应在系统浏览器打开。 |
| HTTPS正常但麦克风仍灰色 | HTTPS是必要条件而不是充分条件；当前浏览器不支持processLocally时，本项目为避免音频外传会禁用麦克风。 |
| 无英语朗读 | 系统未安装本地英语TTS，或浏览器阻止自动播放；安装本地语音包，再点击“再听一遍”。 |
| AI接口503 | 未填写真实API Key、并发已满，或服务未准备好。 |
| AI接口502 | 检查云服务器到DeepSeek的连接、模型权限、余额；检查服务端超时。项目不会把上游敏感错误正文显示给学生。 |
| 429 | IP请求过频、登录失败过多或当日AI预算达到上限。 |
| 保存失败507 | 已达到JSON文件容量限制，管理员需先备份归档。 |
| 保存失败500 | 查看PM2不含文本内容的错误记录，检查数据目录写权限、磁盘空间与JSON完整性；不要清空文件尝试“修复”。 |
| 登录后又回到登录页 | 生产Secure Cookie要求HTTPS；不能多实例运行；重启或8小时到期会撤销登录。 |
| 手机关页后数据未完整保存 | 已成功生成的AI轮次会逐轮写入PostgreSQL；若某轮保存失败，页面会提示并在结束时重试。强制关闭前尚未保存成功的轮次无法恢复；未完成的练习可能保留为 `active`。 |

## 10. 研究使用说明

部署前由项目负责人填写实际的数据处理联系人、研究目的、保留期限、删除/退出安排并告知监护人及学校；通用隐私页面不代替具体研究授权。只收集完成研究所需的字段，不启用音频采集。AI服务会处理转写文字，项目运营者应核对服务商的实际数据政策，不能把“无音频上传”解释成“没有任何第三方文本处理”。
