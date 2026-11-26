# bili-in-code

把 B 站视频铺在 VS Code 编辑区的背景层：代码浮在画面上，右下角悬浮控制条负责播放。支持点播、直播、弹幕和小屏模式。

视频介绍：https://www.bilibili.com/video/BV1qVygzJEjs
下载：[Releases](https://github.com/GhostFace-yz/vscode_bilibili_player/releases)

## 安装依赖

- macOS：`brew install ffmpeg`
- Windows：`winget install Gyan.FFmpeg`，或把 `ffmpeg.exe` 放到 `C:\ffmpeg\bin\ffmpeg.exe`
- 也可以手动指定：设置环境变量 `BILI_FFMPEG_PATH` 指向 ffmpeg 可执行文件

## 启动

命令面板（`Cmd/Ctrl+Shift+P`）执行 **bili-in-code: 开启**，确认「应用并重载」。

## 使用

输入 BV 号/视频链接，等「音频已就绪」的提示后点播放；也可以扫码登录，或打开「直播模式」看直播。

## 关闭

**bili-in-code: 关闭（还原工作台）**

## 弹幕

点播按播放时间、直播实时，逐条打印到「Bilibili 皮肤」输出面板；命令面板执行 **bili-in-code: 打开控制台** 查看。

> 皮肤默认关闭：每次打开 VS Code 或重载窗口后都不会自动显示，执行「开启」才出现。
>
> 开启皮肤会修改 VS Code 安装目录里的 `workbench.html` 并同步 `product.json` 校验和。VS Code 升级覆盖这个文件后，扩展会在下次启动时自动补回注入，但皮肤仍保持关闭，执行「开启」才显示。
>
> 应用后如果右下角出现「Code 安装似乎损坏」，这是当前进程缓存了旧校验和导致的误报：完全退出 VS Code 再打开就恢复正常，皮肤本身不受影响。
>
> 卸载扩展不会清理这个注入（VS Code 不提供卸载钩子）。直接卸载后，残留脚本探测不到本地服务会保持隐藏，不会弹设置面板；想连 CSP 一起还原，请在卸载前先执行「关闭（还原工作台）」。「关闭（还原工作台）」随时可以恢复原状。
