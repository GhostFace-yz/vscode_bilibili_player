# Changelog

## 0.4.13

- 胶囊里的播放/暂停按钮移到标题左侧
- 宽胶囊 → 迷你胶囊改为右侧固定、宽度从左侧收缩，时长 460ms（原 180ms）；播放图标同步转一整圈，展开时反向转回
- 面板 → 胶囊的收起动画从 300ms 放慢到 500ms，内容模糊/淡出同步延长

## 0.4.12

- 新增「隐藏播放模式」设置（HUD 内 shadcn Switch）：关闭时视频始终按用户设置显示；开启后只有鼠标停在 HUD 上才应用透明度/模糊/暗化，移开时 `opacity=0`、`dim=1`（暗化 100%）
- 收起胶囊改为两种状态：悬停时是 400px 宽条（与展开面板同宽），移开后收缩成只保留播放/暂停按钮的迷你胶囊；播放键固定在最右侧，展开时不会从鼠标下移走
- 视频透明度/模糊/暗化增加 220ms 过渡，悬停切换不突兀
- 面板内新增 Switch 行，设置持久化到 `bilibiliPlayer.hiddenMode`

## 0.4.11

- 视频层右侧收窄到代码地图（minimap）左缘：读取 `.minimap` 的实际 `getBoundingClientRect()`，取贴着编辑器右缘的最右侧 minimap，把它从 `editorBounds.width` 里扣掉，避免视频盖住代码地图
- 兼容 minimap 关闭（宽度为 0 时跳过）、minimap 在左侧、分屏等配置；仍由 1s 轮询 + ResizeObserver 跟随布局变化

## 0.4.10

- 修复音画同步反馈环：`syncAudio` 之前每次 `canplay` 都强制写 `audio.currentTime`，触发 `seek -> canplay -> seek` 死循环，几秒内产生 3 万多次事件并把渲染进程拖死（日志里 `audio canplay` / `audio playing` 刷屏，随后 VS Code 窗口崩溃）
- 现在只在漂移超过 300ms 且距上次 seek 超过 1s 时对齐，并跳过 `audio.seeking` 状态
- 音频 `play()` 增加 pending 锁，避免同一时刻重复播放
- 媒体事件日志按类型 1s 节流；`client.log` 超过 5MB 时自动轮转到 `.old`
- 声音已验证可用：AAC→MP3 转码后 `<audio>` 能正常解码（`audioBytes` 持续增长），`测试声音` 不再是唯一出声路径

## 0.4.9

- 定位到无声根因：VS Code 自带的 `libffmpeg.dylib` **没有 AAC 解码器**（只有 mp3 / flac / vorbis / pcm），B 站音轨无论是 mp4 内嵌 AAC 还是独立 m4s 都会报 `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`；WAV 测试音能正常解码
- 音频改由扩展宿主转码：`ffmpeg`（优先，AAC→MP3 192k）或 macOS 自带 `afconvert`（兜底，AAC→32kHz 单声道 WAV），再交给 `<audio>` 播放
- `/api/audio/transcoded` 按 m4s 路径缓存转码结果，支持 Range/拖动；缓存保留最近 8 个文件
- 原生 720P 也使用转码音轨，video 始终静音，避免 AAC 内嵌音轨无声
- 「测试声音」增加 MP3/WAV 探测和 `canPlayType` / `MediaSource.isTypeSupported` 日志，用来确认 workbench 的解码能力
- 移除 0.4.8 的 fetch→Blob 音轨路径（问题不是网络，是 AAC 解码）

## 0.4.8

- 独立音轨改为 `fetch -> Blob -> <audio src="blob:...">`：workbench 里 `<audio>` 直接请求 `http://127.0.0.1` 会被静默拦截（`error 4` 且 message 为空），而同一 URL 用 CORS `fetch` 正常，因此先把音轨字节抓下来再播放，并保留多个 CDN 备选源
- 原生 720P 不再挂独立音轨，直接使用 mp4 内嵌 AAC；播放 4 秒后若 `webkitAudioDecodedByteCount` 仍为 0，自动切换到独立音轨
- 「测试声音」改用 Web Audio `AudioContext` 振荡器（不经过 CSP/media-src，也不依赖网络），同时用 `<audio>` 拉本地 `/api/test-tone.wav` 验证媒体链路
- 新增渲染进程日志：媒体事件、未捕获异常、`play()/fetch` 失败都会 POST 到 `/api/client-log`，写入扩展 globalStorage 的 `client.log` 并输出到「Bilibili 皮肤」输出通道
- `/api/diagnostics` 增加最近 600 条历史（`?history=1`），方便回看播放/暂停/切源时间线
- CSP `media-src` 增加 `data:`（Web Audio 不需要，但保留给后续音频测试）

## 0.4.7

- 音轨改走本地代理 `/api/audio`：扩展宿主补 Referer/UA、把 `application/octet-stream` 规范成 `audio/mp4`、转发 Range；解决 VS Code 里 `<audio>` 直接请求 B 站 m4s 的 `MEDIA_ERR_SRC_NOT_SUPPORTED`
- 原生 720P 也获取一条 DASH 音轨，video 静音、独立 audio 出声；外置音轨失败时自动退回 video 内嵌音轨
- CSP `media-src` 增加 `http://127.0.0.1:*`
- 新增 HUD「测试声音」按钮（0.8s 440Hz WAV），用于区分 workbench 媒体输出问题
- 0.4.6 的 DASH 失败自动回退 720P / 暂停提示修复保留

## 0.4.6

- 修复 DASH 音轨在 VS Code 中 `MEDIA_ERR_SRC_NOT_SUPPORTED`（诊断显示 audio.error=4）导致无声：audio 增加 `no-referrer`、改为 1px 可视隐藏元素、音轨失败时依次尝试 `audioBackupUrls`，全部失败自动回退 720P 原生 mp4（音轨在 video 内）
- 忽略暂停导致的 `AbortError`，不再弹出“声音被阻止”黄色提示
- 移除“点播放键先解锁音轨”的特殊分支，恢复播放键始终可暂停
- 诊断上报增加 audio.error.message / networkState

## 0.4.5

- 增加 `/api/diagnostics` 本地诊断端点，HUD 每 2s 上报真实媒体状态（video/audio 的 muted/volume/paused/readyState/error、音画 drift、外部 media）
- 增加自动播放解锁：用户点击画面/按键时在真实手势里重新 `play()` 独立音轨并取消静音；被拦截时 HUD 显示提示
- 修复 DASH 音轨被自动播放策略挡住时“有画面没声音”的场景

## 0.4.4

- 修复音频生命周期关键 bug：切换清晰度/切回原生时，`load()` 先暂停旧音轨，但 250ms 同步循环又把它 `play()` 回来；随后 React 卸载旧 `<audio>`，它会变成 detached element 继续出声，导致“音画完全不同步 + 暂停还在响”
- `load()` 现在立即暂停并卸载旧音轨、标记 `audioSwitching`、用请求序号防止旧响应覆盖新音轨；切换完成后才挂载/播放新音轨
- 隐藏皮肤时不再卸载 `<video>/<audio>`，而是保持挂载、`display:none` 并暂停，避免卸载后的幽灵音频
- 实测 DASH→原生切换后旧 audio `paused=true`，DOM 中只剩 0 个音轨，不再出现第二条音轨

## 0.4.3

- 按钮/播放键/滑杆改用 VS Code 活动栏徽章配色：`activityBarBadge.background` / `activityBarBadge.foreground`（Dracula `#FF79C6` / `#F8F8F2`），滑杆增加同色已填充进度
- 音频元素按 `audioSrc` 重新挂载并强制 `load()`，避免切换清晰度/选集后复用旧 `<audio>` 导致播放上一段音轨
- 持续扫描并暂停/静音其它 B 站 DOM 媒体（旧 bilibilihelper 后台视频等），避免出现第二条音轨

## 0.4.2

- 音画同步：独立音轨每 250ms 校准一次，漂移 >120ms 立即 seek；暂停/拖动/缓冲时同时暂停 audio，修复“暂停了声音还在放”
- 切清晰度/切回原生 mp4 时停掉旧 audio；旧版 bilibilihelper 注入的背景 media 也会被暂停并静音
- 主题细节：边框改用编辑器输入框的细边框（`input.border`/`dropdown.border`），按钮、播放键、滑杆改用主题的鲜艳强调色（`focusBorder`），不再用 Dracula 偏灰的 `button.background`

## 0.4.1

- 修复主题变量作用域：VS Code 把 `--vscode-*` 定义在 `.monaco-workbench` 上，之前 HUD/视频层/Radix Portal 挂在 `body`，实际一直用回退色；现在全部挂到 workbench 内部，Portal 也移入 HUD，Dracula 等主题的颜色会真正生效
- 播放/暂停、`loadedmetadata`、`play` 时重新应用 `muted`/`volume`，修复自动播放阶段被浏览器静音后一直无声；音量滑杆固定 64px，不再挤占清晰度/铺满控件，并持久化静音状态
- 已重新同步 workbench 校验和；若仍看到「Code 安装似乎损坏」，需要完全退出并重新打开 VS Code（主进程会缓存启动时的校验结果，仅 Reload Window 不一定刷新）

## 0.4.0

- HUD 全量跟随当前 VS Code 主题：面板、按钮、输入框、下拉、滑杆、提示、弹窗均使用 `--vscode-*` 颜色变量，切换主题实时生效；只有「大会员」标签保留 B 站粉
- 暗化改为叠加当前编辑器背景色，100% 时完全回到原编辑区颜色（浅色主题不再变黑）
- 修复编辑区吸顶滚动（sticky scroll）在顶部盖出一条不透明横带的问题；滚动到方法内部时不再遮挡视频
- 收起/展开改为「内容模糊 → 尺寸过渡 → 取消模糊」的 morph 动画，面板从胶囊矩形长出/缩回
- 播放失败的重试按钮、刷新二维码等改用 shadcn/ui 风格 Button；错误/提示框使用主题校验色
- 修复登录二维码未水平居中的问题

## 0.3.0

- 1080P/1080P+：qnl > 720P 时自动请求 DASH，视频轨 + 独立 AAC 音轨同步播放；720P 及以下继续用 mp4 durl
- 清晰度选择失败时显示“已回落”提示，不再静默跳回 720P
- 视频层只铺编辑器内容区域，随侧边栏/终端/聊天栏大小变化；HUD 同步贴到编辑区右下角
- 非编辑区恢复原生不透明背景，不再透出视频
- 放宽 media-src 到 `https:` 以支持 B 站 DASH 的多个 CDN 域名

## 0.2.2

- 修复 VS Code `require-trusted-types-for 'script'` 下 HUD 空白：移除 Radix Select Viewport 注入的 `<style dangerouslySetInnerHTML>`，改用普通滚动容器
- 修复重载时输出通道已关闭导致「应用皮肤」中断；`visible` 在注入前先置为 true
- 皮肤版本变化后自动重新显示一次，避免升级后停在隐藏状态

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
