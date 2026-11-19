# vscode_bilibili_player

<img src="media/logo.png" width="96" align="right" alt="logo" />

把 B 站视频铺在 VS Code 工作台最底层：视频在代码下面播放，编辑区、侧边栏透明/半透明，右下角悬浮控制条——写代码和看视频真正在同一个画面里，而不是挤一个侧边栏。

> v0.3.0：工作台注入、直连播放、扫码登录、React + Tailwind HUD、登录后刷新清晰度、上下集切换、shadcn Select、GSAP 动画，已在 macOS / VS Code 1.147 实测。包管理工具为 **pnpm**。

## 功能

- **真·皮肤**：视频层 `z-index: -1`，代码浮在视频上；侧边栏、状态栏、标签页半透明
- **直连播放**：≤720P 用 B 站 mp4 durl；1080P/1080P+ 自动切到 DASH 视频流 + 独立音轨，`<video>`/`<audio>` 原生播放并同步，支持播放/暂停/进度/音量
- **扫码登录**：HUD 内生成二维码，Cookie 存 VS Code `SecretStorage`；未登录也可播放 480P/720P（取决于视频）
- **HUD 控制**：播放/暂停、进度、音量、静音、清晰度、铺满方式、透明度、模糊、暗化、换 BV、收起、隐藏
- **视频只铺编辑区**：视频层跟随编辑器内容区域（侧边栏/终端/聊天栏会正常遮挡），HUD 也贴在编辑区右下角
- **登录后刷新清晰度**：扫码登录成功后自动重拉 playurl，清晰度列表与当前画质随之更新；也可点刷新按钮手动更新
- **上下集切换**：支持多 P 视频和 B 站合集/season，HUD 显示「第 X/Y 集」、上一集/下一集和选集下拉
- **HUD 组件**：图标来自 [xicons](https://xicons.org/)（Tabler），下拉选择使用 shadcn/ui 风格的 Radix Select，收起/展开/登录弹窗用 GSAP 动画
- **安全模式**：不改任何安装文件的 Webview 播放器，作为兜底
- **可还原**：自动备份、注入内容可完整移除、CSP 与 `product.json` 校验和自动恢复/修正
- **兼容旧补丁**：检测到之前手动注入的 `#bilibili-background-video` 时，会在皮肤显示期间自动隐藏它

## 安装与运行

需要 Node.js 20+、pnpm 10+（`corepack enable` 或直接安装 pnpm）。

```bash
pnpm install
pnpm run compile     # 构建扩展 + 皮肤 + Tailwind 到 dist/
```

### 方式 A：开发调试（F5）

1. 在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host
2. 命令面板执行 `B站皮肤: 应用皮肤（注入工作台）` → 「应用并重载」
3. 重载后右下角出现 HUD：输入 BV 号（如 `BV1GJ411x7h7`）播放，或点「扫码登录」

### 方式 B：日常使用（安装 VSIX）

```bash
pnpm run vsix
```

生成 `vscode-bilibili-player-0.3.0.vsix`，然后在 VS Code 扩展面板右上角 `...` → **从 VSIX 安装**，重载窗口后执行 `B站皮肤: 应用皮肤`。

### 为什么 `pnpm run compile` 后“没有效果”？

`compile` 只负责**构建产物到 `dist/`**，它不会启动扩展，也不会自动更新已经注入到 VS Code 里的皮肤：

- 如果还没安装/启动扩展：用上面的 F5 或安装 VSIX
- 如果已经应用过皮肤：重新编译后要再执行一次 `B站皮肤: 应用皮肤`（或「仅应用」后重载），因为注入到 workbench 目录的是构建产物副本
- 皮肤更新后重载窗口才会生效（命令里选「应用并重载」会自动重载）

### F5 没反应 / 没有打开新窗口？

- F5 会打开一个**新窗口**，标题类似 `[Extension Development Host] vscode_bilibili_player`；命令面板操作要在**新窗口**里做，不是原来那个窗口
- 先确认 `dist/extension.js` 存在：在项目终端执行 `pnpm run compile`
- 之前的 `.vscode/launch.json` 在 F5 前调用了 `pnpm`，但 macOS 从 Dock 启动的 VS Code 的 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 pnpm，任务失败就不会启动扩展宿主。现已移除 `preLaunchTask`，所以 F5 不再依赖 pnpm；改完代码先在终端编译，再按 F5
- 工作区如果处于 Restricted Mode（不受信任），扩展调试会被禁用：命令面板运行 `Workspaces: Trust` 信任本目录
- 如果按 F5 弹出 “Select environment”，选 **VS Code Extension Development**
- 还是不行就直接装 VSIX（方式 B），不依赖 F5

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
- **xicons / @ricons/tabler**：HUD 图标（播放、音量、收起、上下集、刷新等）
- **shadcn-style Radix Select**：清晰度、铺满方式、选集下拉
- **GSAP + @gsap/react**：HUD 收起/展开、登录弹窗、切换动效
- **esbuild**：扩展（CJS / Node）与皮肤（IIFE / 浏览器）双产物
- **pnpm 10**：包管理与 lockfile
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

- ≤720P 使用 mp4 durl；1080P/1080P+ 使用 DASH（独立音视频轨，原生 `<video>`+`<audio>` 同步）。清晰度上限仍取决于账号：1080P 需登录，1080P+/4K 需大会员且视频提供对应轨
- 4K/8K 可能只有 HEVC/AV1 轨，Electron 能否解码取决于系统；AVC 1080P 最稳
- CDN 播放地址有时效；加载失败时 HUD 会尝试备用地址，仍失败可点「重试」
- 修改了 VS Code 安装目录：**VS Code 升级后需要重新应用皮肤**；`还原工作台` 可随时恢复
- VS Code 的 `product.json` 校验和是**无 `=` 填充的 base64**，扩展已按此适配；如果你之前用其它工具改过 `workbench.js` 等文件，会看到「安装已损坏」提示，运行 `修复校验和` 即可
- 未实现弹幕、播放列表、DASH 1080P+；安全模式仅内嵌官方 iframe，控制能力有限

## 开发

```bash
pnpm run check       # tsc --noEmit
pnpm run watch       # esbuild + tailwind watch
pnpm run compile     # 构建到 dist/
pnpm run package     # 生产构建
pnpm run vsix        # 生产构建 + 打包 VSIX
```

浏览器里预览 HUD（不需要动 VS Code）：

```bash
pnpm run dev:server              # 127.0.0.1:17321
python3 -m http.server 8099      # 另一个终端
# 打开 http://127.0.0.1:8099/test/hud-fixture.html
```

## 免责声明

- 皮肤模式会修改 VS Code 安装目录中的 `workbench.html` 并写入皮肤文件；扩展会备份原文件、提供还原，并对校验和做修正，但仍请自行评估风险。
- 视频内容版权归 B 站及原作者所有；本扩展只做播放，不提供下载、缓存或二次分发。
- 使用需遵守哔哩哔哩服务条款。
