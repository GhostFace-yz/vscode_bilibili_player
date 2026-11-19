# Changelog

## 0.2.1

- HUD 只连接带 `apiVersion >= 2` 的本地服务，避免多窗口升级期间连到旧版扩展而崩溃
- `episodes` 等新字段做兼容性判空

## 0.2.0

- HUD 图标全部替换为 xicons（Tabler），移除 emoji/字符图标
- 清晰度/铺满方式/选集下拉改用 shadcn/ui 风格 Radix Select
- HUD 收起/展开、登录弹窗、面板进出使用 GSAP 动画
- 登录/退出后自动刷新 playurl，清晰度列表即时更新；新增手动刷新清晰度按钮
- 支持多 P 视频与 B 站合集/season 的上一集/下一集/选集切换

## 0.1.1

- 包管理切换到 pnpm（移除 package-lock.json，新增 pnpm-lock.yaml）
- 新增扩展图标与 HUD 头像 logo（`src/asset/logo.png` 裁剪为 128/96px）
- 新增 `pnpm run vsix` 打包命令
- 补充“compile 后为什么没效果”的说明
- 修复 F5 无法启动扩展宿主：移除 `preLaunchTask`（macOS GUI 的 PATH 找不到 pnpm）

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
