# vscode_bilibili_player

把 B 站视频铺在 VS Code 工作台最底层：视频在代码下面播放，编辑区、侧边栏透明/半透明，右下角悬浮控制条——写代码和看视频真正在同一个画面里，而不是挤一个侧边栏。

> v0.1.0：工作台注入、720P 直连播放、扫码登录、React + Tailwind HUD 已完成，并在 macOS / VS Code 1.147 上实测通过。

## 功能

- **真·皮肤**：视频层 `z-index: -1`，代码浮在视频上；侧边栏、状态栏、标签页半透明
- **直连播放**：扩展宿主请求 B 站 playurl，`<video>` 直接播放 CDN 的 mp4 流，支持播放/暂停/进度/音量/倍速（浏览器原生）
- **扫码登录**：HUD 内生成二维码，Cookie 存 VS Code `SecretStorage`；未登录也可播放 480P/720P（取决于视频）
- **HUD 控制**：播放/暂停、进度、音量、静音、清晰度、铺满方式、透明度、模糊、暗化、换 BV、收起、隐藏
- **安全模式**：不改任何安装文件的 Webview 播放器，作为兜底
- **可还原**：自动备份、注入内容可完整移除、CSP 与 `product.json` 校验和自动恢复/修正
- **兼容旧补丁**：检测到之前手动注入的 `#bilibili-background-video` 时，会在皮肤显示期间自动隐藏它

## 安装与运行

```bash
npm install
npm run compile     # 构建扩展 + 皮肤 + Tailwind
```

> 需要 Node.js 20+。如果 `npm install` 报 `~/.npm` 权限错误（本机曾出现过），改用项目内缓存：
> `npm install --cache ./.npm-cache`。

在 VS Code 中打开本目录，按 `F5` 启动扩展开发宿主，然后执行：

1. `B站皮肤: 应用皮肤（注入工作台）` → 选择「应用并重载」
2. 重载后右下角出现 HUD
3. 输入 BV 号（如 `BV1GJ411x7h7`）→ 播放；或点「扫码登录」

> 「应用皮肤」会修改 VS Code 安装目录中的 `workbench.html`（以及写入 3 个皮肤文件），需要当前用户对安装目录有写权限。macOS 正常安装在 `/Applications` 时一般可直接写入。

## 命令

| 命令 | 说明 |
| --- | --- |
| `B站皮肤: 播放视频…` | 输入 BV / av / 链接，在皮肤中播放（未应用皮肤时回退安全模式） |
| `B站皮肤: 显示/隐藏皮肤` | 切换视频层与 HUD，快捷键 `Cmd/Ctrl+Alt+B` |
| `B站皮肤: 扫码登录` | 打开 HUD 登录二维码 |
| `B站皮肤: 应用皮肤（注入工作台）` | 注入 workbench，支持「应用并重载 / 仅应用」 |
| `B站皮肤: 还原工作台` | 移除注入、恢复 CSP 与校验和 |
| `B站皮肤: 修复校验和（消除安装损坏提示）` | 用当前文件重算 `product.json` 校验和 |
| `B站皮肤: 在编辑器区域打开播放器(安全模式)` | 零侵入的 Webview 播放器 |
| `B站皮肤: 显示日志` | 查看本地 API、注入、登录日志 |

播放快捷键：`Cmd/Ctrl+Alt+Shift+B`。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `bilibiliPlayer.defaultVideo` | `""` | 默认视频（BV/av/链接） |
| `bilibiliPlayer.opacity` | `0.5` | 视频层不透明度 |
| `bilibiliPlayer.blur` | `2` | 视频模糊半径（px） |
| `bilibiliPlayer.dim` | `0.25` | 视频上方黑色暗化层，越大代码越清晰 |
| `bilibiliPlayer.fit` | `cover` | `cover` / `contain` / `fill` |
| `bilibiliPlayer.muted` | `true` | 静音播放 |
| `bilibiliPlayer.autoplay` | `true` | 自动播放 |
| `bilibiliPlayer.quality` | `80` | 期望清晰度（未登录通常回落到 720P/480P） |

所有外观参数都能在 HUD 里实时调整，并写回设置。

## 技术栈

- **TypeScript**：扩展宿主 + 注入脚本 + React HUD
- **React 19 + Tailwind CSS 3**：HUD。Tailwind 关闭了 preflight、类名加 `bp-` 前缀、作用域限定在 `#bili-skin-hud`，避免重置 VS Code 工作台样式
- **esbuild**：扩展（CJS / Node）与皮肤（IIFE / 浏览器）双产物
- **Node.js**：本地 HTTP API（127.0.0.1:17321–17330）、B 站 API、Cookie、文件补丁
- **qrcode**：本地生成登录二维码

数据流：

```
HUD (React, 注入 workbench)
   │  fetch + x-bili-token
   ▼
扩展宿主本地 API 127.0.0.1:17321
   ├── /api/state   皮肤状态、设置、登录用户
   ├── /api/play    B 站 view + playurl（带 Referer/UA/Cookie）
   ├── /api/login/* 扫码登录
   └── /api/logout
   │
   ▼
api.bilibili.com / passport.bilibili.com
   │  返回 mp4 durl
   ▼
<video src="https://*.bilivideo.com/...">  ← 直接由 Chromium 播放
```

媒体流不经过本地代理，只有 B 站 API（需要 Referer/Cookie、且受浏览器 CORS 限制）走扩展宿主。

## 目录

```
src/
  extension.ts            # 命令、状态栏、服务生命周期
  state.ts                # 皮肤状态（visible/video/settings）
  config.ts               # 设置读写与校验
  bilibili/
    client.ts             # B 站 API 封装（view / playurl / nav）
    auth.ts               # 扫码登录、Cookie、用户信息
    playurl.ts            # durl 解析与清晰度
    cookies.ts            # Set-Cookie 解析
    parse.ts              # BV/av/链接解析
  server/apiServer.ts     # 本地 HTTP API + CORS + token
  workbench/
    locate.ts             # 探测 workbench.html（electron-browser/sandbox）
    patcher.ts            # 注入/还原/备份/cache-bust
    csp.ts                # CSP 追加 media/connect 源
    checksums.ts          # product.json 校验和（无填充 base64）
  skin/
    main.tsx              # 注入入口（IIFE）
    Hud.tsx               # React HUD + 视频层
    api.ts                # 本地 API 客户端（端口自动发现）
    tailwind.css          # 透明工作台样式 + HUD 样式
  webview/playerPanel.ts  # 安全模式播放器
scripts/
  dev-server.ts           # 脱离 VS Code 调试 API/HUD
  test-patcher.ts         # 在临时目录验证注入/还原/校验和
test/hud-fixture.html     # 浏览器里预览 HUD
```

## 已知限制

- 使用 `fnval=1 + platform=html5` 的 mp4 durl，清晰度通常封顶 720P；1080P+/4K 需要 DASH + MSE（后续路线，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）
- CDN 播放地址有时效；加载失败时 HUD 会尝试备用地址，仍失败可点「重试」
- 修改了 VS Code 安装目录：**VS Code 升级后需要重新应用皮肤**；`还原工作台` 可随时恢复
- VS Code 的 `product.json` 校验和是**无 `=` 填充的 base64**，扩展已按此适配；如果你之前用其它工具改过 `workbench.js` 等文件，会看到「安装已损坏」提示，运行 `修复校验和` 即可
- 未实现弹幕、播放列表、DASH 1080P+；安全模式仅内嵌官方 iframe，控制能力有限

## 开发

```bash
npm run check     # tsc --noEmit
npm run watch     # esbuild + tailwind watch
npm run compile   # 生产构建到 dist/
npm run package   # 生产构建（供 vsce 打包）
```

浏览器里预览 HUD（不需要动 VS Code）：

```bash
node -e "require('esbuild').buildSync({entryPoints:['scripts/dev-server.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist/dev-server.cjs',target:'node20'})"
node dist/dev-server.cjs        # 127.0.0.1:17321
python3 -m http.server 8099      # 另一个终端
# 打开 http://127.0.0.1:8099/test/hud-fixture.html
```

## 免责声明

- 皮肤模式会修改 VS Code 安装目录中的 `workbench.html` 并写入皮肤文件；扩展会备份原文件、提供还原，并对校验和做修正，但仍请自行评估风险。
- 视频内容版权归 B 站及原作者所有；本扩展只做播放，不提供下载、缓存或二次分发。
- 使用需遵守哔哩哔哩服务条款。
