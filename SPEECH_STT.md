# 手机可靠语音输入

浏览器识别仍作为支持设备的快速路径。配置服务端 STT 后，Android / QQ 浏览器优先使用 MediaRecorder；其他设备遇到浏览器 aborted、network、无最终结果或超时后自动改用录音路径。切换后会提示重新说一句，之前浏览器没有提供的录音无法追回。STT 仅产生文字，之后继续进入原来的自由聊天或情景接口、签名回执和逐轮保存流程。

## 腾讯云 ASR

使用独立的语音识别 ASR 产品（不是 DeepSeek，也不是 TRTC）：

- [开通语音识别](https://console.cloud.tencent.com/asr)
- [一句话识别 API](https://cloud.tencent.com/document/api/1093/35646)
- [CAM 访问管理](https://console.cloud.tencent.com/cam)

英语模型固定 `16k_en`，请求 `SentenceRecognition`。建议为网站创建独立 CAM 子用户密钥，仅授予 `asr:SentenceRecognition` 权限，不使用具有全部云资源权限的主账号密钥。开通后的可用额度及计费以控制台为准，不在代码中假设免费。

环境变量仅放在服务器 `.env`（权限 600）或进程环境：

| 名称 | 用途 |
| --- | --- |
| `STT_PROVIDER=tencent` | 启用腾讯云；默认 `disabled` |
| `TENCENT_ASR_SECRET_ID` | CAM SecretId，只在后端使用 |
| `TENCENT_ASR_SECRET_KEY` | CAM SecretKey，只在后端使用 |
| `STT_FFMPEG_PATH` | FFmpeg 可执行程序；默认 `ffmpeg` |
| `STT_DAILY_LIMIT` | 单进程每日请求上限；默认 500，重启计数归零 |

Ubuntu 安装音频转换程序（仅首次需要）：

```bash
sudo apt-get install -y --no-install-recommends ffmpeg
ffmpeg -version
```

在服务器交互式 SSH 终端、项目目录运行：

```bash
npm run stt:configure
npm run stt:check
```

`stt:configure` 不回显输入，只增加 ASR 配置，保留现有 Neon、DeepSeek 和 Session 变量；不接受命令行密钥参数。不要把密钥发到聊天、提交 Git 或放在 public。`stt:check` 检查配置和转换器就绪；不等于真实声音已识别。真实识别须在配置后用手机完成。

配置后重启 PM2：

```bash
pm2 restart yuban-tongxing
```

## HTTPS 代理

只有 `/api/speech/transcribe` 接收原始音频请求体。Nginx 需要为该路径设置 `client_max_body_size 2m`、`proxy_request_buffering off` 和 `proxy_http_version 1.1`，防止请求体被代理暂存到磁盘；其他 JSON API 保持原有上限。对应示例在 `deploy/nginx-speech-location.conf`，放在 HTTPS `server` 内。不把 Node 内部端口公开。

## 内存与权限

录音单次最多 25 秒、2 MiB；后端再次验证 MIME、文件头、解码后时长、大小。上传须有学生登录 Session、同源 Origin 和 `X-Requested-With: ybtc`。限流与并发上限用于控制成本。固定 FFmpeg 格式与输入管道，不接受远程音频 URL。录音通过 stdin 转为 16kHz 单声道 PCM，stdout 直接进入 STT provider，全程不创建临时音频文件。请求结束、异常或取消时停止轨道、释放/清空内存缓冲；不在日志记录原始音频或识别文本。

腾讯云会收到识别所必需的音频，其处理与留存以服务条款为准。网站不落盘不代表能够保证第三方不留存。已有隐私说明和练习勾选文字已体现临时音频上传。未来发音评测可在同一次内存音频处理作用域内接入，当前不生成任何发音分数。

## 验收

`npm test` 验证浏览器/录音路径、恢复、清理、权限及上传约束。现有 auth / practice / admin 数据库测试继续运行。自动测试的音频与文本替身仅用于隔离测试，不能作为手机真实识别验收。上线后手机说三句英语，检查 transcript、DeepSeek、TTS、history 与逐轮数据库记录。检查页 `/speech-test.html` 不读取转写内容，也不上传诊断录音。
