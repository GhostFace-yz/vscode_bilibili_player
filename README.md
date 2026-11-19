# vscode_bilibili_player

把 B 站视频做成 VS Code 的「皮肤」：视频在工作台最底层播放，编辑区背景透明/半透明，写代码的同时看视频——而不是在侧边栏或单独标签页里挤一小块区域。

> 当前状态：v0.0.1 脚手架。仓库已连通 GitHub，安全模式播放器可用；工作台注入方案与播放内核待确认，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 已实现

- TypeScript + esbuild 扩展脚手架，F5 可调试
- 输入 BV 号 / av 号 / B 站链接，在编辑器旁打开官方播放器（**安全模式**，零侵入，作为兜底方案）
- 状态栏入口与快捷键 `Cmd/Ctrl+Alt+B`
- 设置项骨架：默认视频、透明度、模糊、铺满方式、静音、自动播放、弹幕、清晰度

## 快速开始

```bash
npm install
npm run compile    # 或 npm run watch
```

在 VS Code 中打开本目录，按 `F5` 启动扩展开发宿主，然后 `Cmd/Ctrl+Shift+P`：

- `B站皮肤: 播放视频…` — 输入 `BV1GJ411x7h7` 或视频链接
- `B站皮肤: 在编辑器区域打开播放器(安全模式)`

## 技术栈

| 层 | 选型 |
| --- | --- |
| 扩展逻辑 | TypeScript（Node.js） |
| 构建 | esbuild |
| 安全模式 UI | Webview + HTML/CSS，内嵌官方 iframe 播放器 |
| 皮肤模式（规划） | 注入 `workbench.html` + 透明主题色 + 全屏视频层 + 原生 DOM HUD |
| 播放内核（规划） | 扩展宿主本地代理 + `<video>`；后续可升级 shaka-player (DASH) |

更多取舍见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 目录结构

```
src/
  extension.ts            # 激活、命令、状态栏
  config.ts               # 设置
  bilibili/parse.ts       # BV/av/链接解析 + iframe 地址
  webview/playerPanel.ts  # 安全模式播放器
docs/ARCHITECTURE.md      # 方案、CSP、播放内核对比
```

## Roadmap

- [x] 仓库初始化、TS 脚手架、安全模式播放器
- [ ] 工作台注入：视频层 + 透明主题 + 自动备份/还原 + checksum 修复
- [ ] HUD：播放控制、透明度、模糊、换视频、快捷键
- [ ] 本地代理播放内核（登录后可 720P+）
- [ ] DASH / 1080P+、弹幕
- [ ] 设置页、播放历史

## 免责声明

- 皮肤模式需要修改 VS Code 安装目录中的 `workbench.html` 等文件，扩展会自动备份并提供还原；请自行评估风险。
- 视频内容版权归 B 站及原作者所有，本扩展仅做播放，不提供下载或缓存。
- 使用需遵守哔哩哔哩服务条款。
