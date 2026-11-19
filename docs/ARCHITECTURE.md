# 架构与方案

目标：**视频不是挤在侧边栏或某个标签页里，而是成为 VS Code 工作台的背景层** —— 编辑区半透明，代码在上、视频在下，同时可看。

> 本文档记录方案取舍与技术栈，供确认后再进入实现。

## 1. 为什么需要特殊手段

VS Code 扩展 API 没有"设置工作台背景视频"的能力，也没有"把 Webview 放到编辑器后面"的 API。`WebviewPanel` 只能是独立标签页，`WebviewView` 只能放在侧边栏/面板区。因此真正的"皮肤"只有两条路：

| 路线 | 原理 | 是否真·皮肤 | 代价 |
| --- | --- | --- | --- |
| **A. 工作台注入（推荐）** | 修改 `workbench.html`，注入脚本创建全屏视频层 + 透明主题色 | ✅ 视频衬在代码下面 | 修改安装目录，升级后需重打补丁，会出现"安装损坏"提示 |
| **B. Webview 播放器（兜底）** | 编辑器旁开一个 Webview 内嵌 B 站播放器 | ❌ 独立区域 | 安全、零侵入，v0.0.1 已实现 |
| C. 原生悬浮窗 | Swift/C# 写一个透明置顶窗口叠在屏幕上 | ❌ 只能覆盖在代码之上 | 三平台各写一套原生代码，遮挡代码、焦点/多屏问题多 |

建议：**A 为主 + B 兜底**，C 不做。

## 2. 路线 A：工作台注入

### 2.1 注入点

以本机 VS Code 1.147.0（macOS）实测：

- `appRoot`：`/Applications/Visual Studio Code.app/Contents/Resources/app`
- 工作台 HTML：`out/vs/code/electron-browser/workbench/workbench.html`
  （旧版本在 `out/vs/code/electron-sandbox/workbench/workbench.html`，需按版本探测）
- 工作台主 JS：`out/vs/workbench/workbench.desktop.main.js`
- `product.json` 内含 `checksums`（sha256 base64），覆盖 `workbench.desktop.main.js`、`preload.js` 等文件

注入内容：

1. 在 `workbench.html` 的 `</body>` 前插入 `<script src="./bilibili-skin.js"></script>`；
2. 把构建产物 `dist/skin.js` 写到同目录（同源，满足 CSP `script-src 'self'`）；
3. 脚本在渲染进程里创建全屏容器（`position: fixed; inset: 0; z-index: -1`），内部放 `<video>` 或 `<iframe>`；
4. 用 `workbench.colorCustomizations` 把 `editor.background`、`sideBar.background`、`panel.background`、`terminal.background` 等改成透明色（`#00000000` 或带 alpha 的 rgba）；
5. 叠加一个悬浮 HUD（播放/暂停、进度、静音、透明度、模糊、换视频、隐藏），用原生 DOM + CSS 实现。

### 2.2 CSP

当前 `workbench.html` 的 CSP 限制了 B 站资源：

```
media-src  'self'
frame-src  'self' vscode-webview:
script-src 'self' 'unsafe-eval' blob:
require-trusted-types-for 'script'
```

打补丁时需要重写 CSP：

- `media-src` 增加 `https://*.bilivideo.com https://*.bilibili.com blob:`
- `frame-src` 增加 `https://player.bilibili.com https://www.bilibili.com`
- `connect-src` 增加 `ws://127.0.0.1:*`（扩展 ↔ 皮肤 RPC，可选）
- 注入脚本不使用 `innerHTML`（受 Trusted Types 约束），全部 `createElement` + `textContent`。

### 2.3 "安装损坏"提示

VS Code 启动时会校验 `product.json.checksums` 中的文件哈希，不匹配就弹"安装已损坏"。处理方式：

- 修改后重算 `workbench.desktop.main.js` / `workbench.html` 等被改文件的 sha256，写回 `product.json` 的 `checksums`；
- 打补丁前备份原文件到扩展 `globalStorage`；
- 提供"还原工作台"命令，恢复备份与 checksums。

### 2.4 升级与失效

VS Code 升级会覆盖 `workbench.html` / `workbench.desktop.main.js`。扩展在启动时比较 `version` 与上次打补丁的版本：

- 版本变化 → 提示"检测到 VS Code 已升级，是否重新应用皮肤？"；
- 也支持监听 `vscode.env.appRoot` 下的文件存在性，判断是否需要重打。

### 2.5 播放内核

| 内核 | 实现 | 清晰度 | 可控制性 | 依赖 |
| --- | --- | --- | --- | --- |
| 官方 iframe | `player.bilibili.com/player.html?bvid=...` | 未登录 480P，登录可 1080P | 极弱（只能换 URL 参数） | 无 |
| 直链 + 本地代理 | 扩展宿主请求 playurl，把带 Referer 的流经 `127.0.0.1` 代理给 `<video>` | 未登录 360/480P，登录 720P+ | 完整（播放/暂停/进度/静音/倍速） | Node http 代理 |
| DASH + MSE | shaka-player / mp4box.js 播放分离的音视频流 | 1080P+/4K | 完整 | shaka-player ≈ 200KB |

推荐：v1 用"直链 + 本地代理"，v2 再上 DASH。官方 iframe 作为兼容回退。

### 2.6 本地代理要点

- 只监听 `127.0.0.1`，随机端口 + 一次性 token，防止被网页滥用；
- 转发 `Range` 请求（B 站 CDN 支持分片），透传 `Content-Range`/`Accept-Ranges`；
- 请求头带 `Referer: https://www.bilibili.com` 与桌面 UA，否则 CDN 403；
- 登录态：`SESSDATA` 等 Cookie 存 `SecretStorage`，只在代理进程内使用。

## 3. 技术栈清单

**必需**

- TypeScript —— 扩展宿主逻辑、注入脚本（同一套类型与构建）
- CSS —— 透明工作台、视频层、HUD 样式
- HTML —— `workbench.html` 注入模板、Webview 页面
- Node.js —— 扩展宿主、本地代理、文件补丁
- JSON —— `package.json` 清单、配置项

**可选**

- `shaka-player` / `mp4box.js` —— DASH 播放（如果要做 1080P+）
- Vitest / `node:test` —— 单元测试（BV 解析、CSP 改写、checksum 计算）
- React / Svelte / Vue —— 设置页；HUD 不建议用框架，原生 DOM 更稳更小
- Swift / C# / GTK —— 仅路线 C 的原生悬浮窗，不建议
- Python —— 仅发布脚本，不必要

结论：**除 TS/CSS/HTML/Node 外，没有必须新增的语言**；真正的可选项是播放内核（shaka-player）和是否做原生方案（Swift/C#）。

## 4. 目录规划（目标）

```
src/
  extension.ts              # 激活、命令、状态栏
  config.ts                 # 设置读取
  bilibili/
    parse.ts                # BV/av/URL 解析（已实现）
    api.ts                  # view / playurl 请求
    auth.ts                 # Cookie / 登录态
  proxy/
    server.ts               # 本地流代理
  workbench/
    locate.ts               # 探测安装路径与版本
    patcher.ts              # 注入 / 还原 / 备份
    csp.ts                  # CSP 改写
    checksums.ts            # 校验和修复
  skin/
    main.ts                 # 注入入口（构建为 IIFE）
    hud.ts                  # 悬浮控制条
    player.ts               # iframe / video 播放器
    styles.ts               # 注入样式
  webview/
    playerPanel.ts          # 安全模式（已实现）
```

## 5. 安全与合规

- 只在用户显式执行"应用皮肤"时改动文件，首次需确认；
- 自动备份 + 一键还原；
- Cookie 只存本地 `SecretStorage`，不上传；
- 不提供下载/缓存视频能力；
- 若上架扩展商店，默认走安全模式（B），注入模式需用户手动开启。
