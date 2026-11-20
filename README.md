# bili-in-code

<img src="media/logo.png" width="120" align="right" alt="logo" />

把 B 站视频铺在 VS Code 编辑区的背景层：代码浮在画面上，右下角悬浮控制条负责播放。支持点播、直播、弹幕和小屏模式。

## 功能

- **背景播放**：视频只铺在编辑区背后，侧边栏、终端、状态栏保持原生不透明；视频层跟随编辑区大小、代码地图和吸顶方法栏自动让位
- **控制条**：播放/暂停、进度（Slider）、音量（悬停出竖直滑条）、清晰度、显示方式（完整/小屏）、透明度/模糊/暗化、移出黑边
- **扫码登录**：HUD 内生成二维码，Cookie 存在 VS Code `SecretStorage`；登录后可看 1080P/1080P+（DASH 独立音轨由扩展宿主转码，绕开 VS Code 缺少 AAC 解码器的问题）
- **直播模式**：贴入直播间链接或房间号即可观看，支持切换清晰度（原画/蓝光/超清/高清/流畅）和刷新直播
- **弹幕**：点播按播放时间、直播实时，逐条打印到「Bilibili 皮肤」输出面板
- **小屏模式**：视频变成可拖动、可缩放的小窗（锁定宽高比），自动避开方法栏和代码地图，位置写进设置
- **缓存可控**：音轨转码缓存在扩展的 globalStorage，默认上限 120MB（`bilibiliPlayer.audioCacheMaxMb`），超出按时间删最旧的
- **主题自适应**：HUD、胶囊、面板、弹窗全部取当前 VS Code 主题色，毛玻璃背景，面板文字不会被视频干扰

## 下载

到 [Releases](https://github.com/GhostFace-yz/vscode_bilibili_player/releases) 下载最新的 `bili-in-code-<version>.vsix`，或者按下面的「安装依赖」从源码构建。

## 安装依赖

**运行时**

- VS Code 桌面版 1.85 及以上
- **ffmpeg**（音轨转码、直播转流、黑边探测都要用）
  - macOS：`brew install ffmpeg`
  - Windows：`winget install Gyan.FFmpeg`，或把 `ffmpeg.exe` 放到 `C:\ffmpeg\bin\ffmpeg.exe`
  - 也可以手动指定：设置环境变量 `BILI_FFMPEG_PATH` 指向 ffmpeg 可执行文件

**从源码构建**

- Node.js 20+、pnpm 10+

```bash
pnpm install
pnpm run vsix     # 生成 bili-in-code-<version>.vsix
```

## 启动

1. 扩展面板右上角 `…` → **Install from VSIX…**，选择下载或构建出来的 vsix
2. 命令面板（`Cmd/Ctrl+Shift+P`）执行 **bili-in-code: 开启**，确认「应用并重载」
3. 重载后右下角出现控制条：输入 BV 号/视频链接播放，或点「扫码登录」；也可以打开「直播模式」看直播
4. 想恢复原样：**bili-in-code: 关闭（还原工作台）**

命令面板里只有三条命令：

| 命令 | 作用 |
| --- | --- |
| `bili-in-code: 开启` | 注入皮肤并显示（`Cmd/Ctrl+Alt+B`） |
| `bili-in-code: 关闭（还原工作台）` | 移除注入、恢复 CSP 与校验和（`Cmd/Ctrl+Alt+Shift+B`） |
| `bili-in-code: 打开控制台` | 打开「Bilibili 皮肤」输出面板，查看弹幕和日志 |

> 开启皮肤会修改 VS Code 安装目录里的 `workbench.html` 并同步 `product.json` 校验和，因此 VS Code 升级后需要重新执行一次「开启」；「关闭（还原工作台）」可以随时恢复，不会残留文件。
