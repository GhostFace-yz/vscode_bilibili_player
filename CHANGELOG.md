# Changelog

## 0.1.0

- 工作台注入：视频层注入 `workbench.html`，透明编辑区/侧边栏，视频在代码下方
- 直连 B 站 CDN（mp4 durl），`<video>` 播放，支持播放/暂停/进度/音量/清晰度
- 本地 HTTP API（127.0.0.1:17321–17330，token 校验）代理 B 站接口
- 扫码登录，Cookie 存 `SecretStorage`
- React + Tailwind HUD：透明度/模糊/暗化/铺满/换视频/收起/隐藏
- 安全模式 Webview 播放器
- 备份、还原、CSP 恢复、`product.json` 校验和修复（无填充 base64）
- 兼容并自动隐藏旧的手动后台视频注入

## 0.0.1

- 初始化 TypeScript + esbuild 扩展脚手架
- 安全模式：内嵌 B 站官方播放器（Webview）
- BV 号 / av 号 / 视频链接解析
- 状态栏入口与快捷键
