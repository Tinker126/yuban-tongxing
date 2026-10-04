# 后续上线核对

- 为因关闭页面或断网遗留的 `active` 练习记录设计到期清理并标记为 `abandoned`；本阶段允许其保留为 `active`。
- 若启用普通 Web Speech Recognition 回退，正式开放前须核对目标浏览器的语音服务与音频处理政策，更新隐私说明和监护人告知，并在 Chrome、Edge 与目标移动浏览器上验证回退路径。当前只有设备端识别路径经过用户真实验收；公网部署仍按用户要求暂停。
- `README.md`、`DEPLOYMENT.md` 和 `public/privacy.html` 仍描述“只使用本地识别”。在下一阶段确认实际上线的识别策略后统一校正文案，不能把普通 Web Speech 回退表述为音频必定留在设备上。
