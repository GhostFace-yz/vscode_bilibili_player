# Changelog

## 0.7.9

- 恢复「默认关闭」：每次打开 VS Code 窗口或重载窗口后皮肤都是关闭状态，只有执行 `bili-in-code: 开启` 才显示
- 首次应用补丁后的那一次重载会自动显示一次（否则看不到效果），之后保持关闭
- VS Code 升级覆盖 `workbench.html` 后仍会自动补回注入，但同样保持关闭
- 修复宽胶囊收起成迷你胶囊时按钮往右漂移：迷你按钮改为贴右边缘的绝对定位，收缩全程和边框保持同样的 6px 间距，不再和 width 速度对不上
- 宽胶囊收起时保留原内容，按 width 从右往左裁掉；左侧播放键原地变成三点按钮并旋转，不再额外出现第二个按钮，动画结束后无缝切到迷你态

## 0.7.8

- 卸载/禁用扩展后不再残留设置面板：注入的脚本启动时先探测本地 API，连不上就完全不挂载，并清掉注入的样式。直接卸载扩展后打开 VS Code 不会再出现「本地服务未启动」的空设置框
- 打开窗口时如果 workbench 里还有注入（上次是开着的），自动显示皮肤，不用每次手动执行「开启」
- HUD 默认收起成右下角胶囊，并记住面板开合状态；不再每次启动都展开设置面板
- VS Code 升级覆盖 `workbench.html` 后，按上次的开启状态自动重新注入（多窗口用锁避免并发写），并提示重载

## 0.7.7

- 扩展改名为 **bili-in-code**（`name` / `displayName` / 命令分类），因为原来的名字在应用商店已被占用
- API 令牌额外持久化到 `~/.vscode-bili-player.token`：改扩展名、换 publisher 导致扩展 ID 变化时令牌保持不变，HUD 不会再因为令牌变化报 401
- 启动时会优先读这个令牌文件，读不到再回退到 globalState / 新生成

## 0.7.6

- 修复部分视频 1080P60 / 高码率画质报 `MEDIA_ERR_SRC_NOT_SUPPORTED`：这些 CDN 节点校验 `Referer`，无 Referer 直接 403，而渲染进程的 `<video>` 带不了 Referer。现在视频和音轨一样走扩展宿主代理（`/api/video`，转发 Range 并补上 Referer / UA），720P/360P 本来就能播的也会继续正常
- 代理支持 Range / 206，拖动进度条照常 seek；请求断开时会销毁上游连接，不会在后台继续下载
- 清理了重复的 CORS 响应头

## 0.7.5

- 命令面板分类从「B站皮肤」改成 `vscode-bilibili-player`，三条命令现在显示为 `vscode-bilibili-player: 开启 / 关闭（还原工作台） / 打开控制台`
- 对应更新两份 README 里的命令名

## 0.7.4

- 修复换 publisher 后一直「本地服务未响应：无效的本地访问令牌」：SkinApi 收到 401 时会重新拉取 `bilibili-skin.config.js`（带 cache buster）拿到新令牌并自动重试，不用手动重载窗口
- 扩展激活时如果发现工作台里的皮肤资源版本/端口/令牌和当前不一致，会自动重新注入（顺带更新 `?v=` 缓存键），并提示「重载窗口」一次
- `displayName` 改为 `vscode-bilibili-player`

## 0.7.3

- 修复切换视频/清晰度时误报「视频加载失败：CDN 链接可能已过期」：切换源码瞬间浏览器会 abort 上一个请求并补一个迟到的 `error`，之前会把它当成失败并依次切换所有备用 CDN，最后弹错误。现在切换后 1.5 秒内的 `error` 会先延迟确认，期间只要 `readyState >= 1` 就忽略，真正加载失败才继续走备用线路
- `publisher` 改为 `YangZheng`

## 0.7.2

- 切换视频/清晰度后自动删除上一条音轨的缓存（只保留当前音轨；20 秒内刚写过/可能被别的窗口占用的文件跳过，Windows 上被占用时留到下次清理）
- 音轨同步期间给用户明确反馈：
  - 宽胶囊里出现 `同步音频` 小胶囊（带 spinner）
  - 面板标题副行显示「正在同步音频…」（替换时间）
  - 右上角 loading toast 改为「正在同步音频，请稍后…」并说明原因（首次播放/切换清晰度要把 AAC 转 MP3，视频越长越久）

## 0.7.1

- 音频缓存改为按总大小清理：默认上限 120MB（`bilibiliPlayer.audioCacheMaxMb`，0 表示只保留最新一个），启动时和每次转码后都会清理，并顺手删掉中断留下的 `.source.m4s` / `.tmp` 碎片
- MP3 码率 192k → 128k，音轨缓存体积约减少 1/3（背景视频够用）
- 客户端日志瘦身：只记录 `loadedmetadata/playing/pause/waiting/error`，并且写入过程中超过 5MB 就轮转 `.old`（原来只在启动时轮转，能涨到十几 MB）
- 启动日志会打印音频缓存占用和上限

## 0.7.0

- logo 换成 `src/asset/files/` 下的新图：HUD 面板/输出、扩展图标（`media/logo.png`）、直播模式左上角统一用 logo（不再显示直播间封面）
- 命令精简为三条：`B站皮肤: 开启`、`B站皮肤: 关闭（还原工作台）`、`B站皮肤: 打开控制台`；删除播放视频、扫码登录、应用/还原、修复校验和、显示日志、安全模式等命令，以及安全模式的 Webview 播放器代码
- 快捷键：`Cmd/Ctrl+Alt+B` 开启，`Cmd/Ctrl+Alt+Shift+B` 关闭（还原）
- README 重写为「下载 / 安装依赖 / 启动 / 功能」四部分，拆成两份：`README.md`（GitHub）和 `README.marketplace.md`（VS Code 应用商店）
- 新增 `pnpm run vsix:store`：临时把商店版 README 换成 `README.md` 再打包，结束后自动还原（finally 保证）

## 0.6.8

- Windows 适配：
  - ffmpeg 查找支持 Windows：`BILI_FFMPEG_PATH`、winget / choco / scoop / `C:\ffmpeg\bin` 等常见目录，`PATH` 扫描按 `PATHEXT` 自动补 `.exe/.cmd/.bat`，并去掉 PATH 里的引号
  - Windows 的 ffmpeg 构建没有 `libmp3lame` 时自动退回 WAV（PCM），不会出现“有画面没声音”
  - 所有 ffmpeg/编码器子进程加 `windowsHide`，不再闪控制台窗口
  - `/api/health` 返回 `audioTranscoder` / `ffmpeg` / `platform`；HUD 启动时如果没找到 ffmpeg 会弹一次提示（带 Windows 安装命令）
  - 启动日志按平台给出安装提示；写入安装目录被拒（EACCES/EPERM）时提示以管理员身份运行 VS Code
  - 修复校验和、备份、范围请求等路径逻辑确认跨平台（`path.join` / `path.sep`）
- 文档补「Windows」章节（ffmpeg、应用皮肤权限、校验和修复、缓存路径）

## 0.6.7

- 宽胶囊的左右留白和上下对齐：`padding: 0 12px` 改成四边 `5px`（加 1px 边框 = 6px），和迷你胶囊的 6px 完全一致，收起动画里按钮不再显得比边框“跑得快”

## 0.6.6

- 修复迷你胶囊按钮没有居中：`.bili-pill` 补上 `justify-content: center`（之前内容只有 28px 宽却贴在左边，左右留白是 1px / 11px，现在四边都是 6px）

## 0.6.5

- 所有进度条统一成 shadcn/Radix `Slider`：设置面板的播放进度、音量、透明度/模糊/暗化（胶囊音量本来就是 Slider），移除原生 `input[type=range]` 和 `rangeFill`
- 直播模式新增「刷新直播」按钮：面板里在清晰度左侧，宽胶囊里在设置按钮右侧（仅直播模式显示，点播不显示）
- 迷你胶囊和宽胶囊高度统一为 40px（宽胶囊原来 46，迷你 40×40）

## 0.6.4

- 修复宽胶囊音量 Tooltip 点不了：`#bili-skin-hud` 是 `pointer-events: none`，Tooltip 又 Portal 在它里面，导致鼠标穿透到编辑器（光标变成文本输入态）；给 `.bili-tooltip` 补上 `pointer-events: auto`，现在可以按住滑杆拖动/点击
- 恢复吸顶滚动（方法栏）的主题背景，之前为了露视频把它做成透明，导致方法栏文字和下面的代码叠在一起
- HUD 实时监听 `.sticky-widget` 的高度：方法栏出现时视频整体下移同样高度，消失后自动上移恢复（小屏模式的禁入区也同步）
- 设置页等非代码编辑器保持不透明（`.settings-editor` 系列），不会透出视频

## 0.6.3

- 修复弹幕输出不自动滚动：弹幕改成一批日志一次 `append`（输出面板只刷一帧），并在第一次输出弹幕时按设置关闭 VS Code 的 `output.smartScroll.enabled`（智能滚动会在点过输出面板后锁住跟随），日志里会注明这次修改；新增设置 `bilibiliPlayer.danmakuAutoScroll`（默认开）
- 直播支持切换清晰度：清晰度下拉在直播模式下显示直播间支持的 qn（原画/蓝光/超清/高清/流畅），切换后用新的 `qn` 重新拉流；上游实际给的清晰度会显示在标题行，切不到时提示「该清晰度当前不可用」
- 直播标题行补充当前清晰度（如 `直播 · 超清 · 主播 · 3.6 万人气`）

## 0.6.2

- 宽胶囊音量改用 shadcn 的 `Tooltip` + `Slider`：悬停音量按钮弹出竖直滑块（紧凑、无大内边距），点击按钮仍然静音/取消静音
- Tooltip 只在胶囊展开完成后挂载（`pillExpanding` 期间不响应），避免从迷你展开时鼠标扫过就弹出来
- 新增**直播模式**：设置面板左下角开关；贴入直播间链接/房间号即可观看直播
  - 宿主用 ffmpeg 把直播 HLS 转成 fMP4 渐进流（H.264 直接 copy、音频转 MP3），所以 VS Code 里直播也有声音，且音画在同一条流里天然同步
  - 直播下隐藏进度条（显示 `LIVE` 标识）、选集和清晰度选择；暂停再继续会回到最新画面
- 直播弹幕：宿主用 B 站弹幕 WebSocket 协议订阅（`getDanmuInfo` 被风控 `-352` 时自动退回历史接口），按消息 id 去重后打印到输出面板
- 修复/优化弹幕发送：改为 400ms 节流，密集弹幕时不再每秒发几十个请求；加载失败、发送失败都会写进客户端日志

## 0.6.1

- 宽胶囊最右侧的「隐藏皮肤」按钮换成弹幕开关（和设置面板里的弹幕按钮同一套状态，打开后高亮）
- 宽胶囊去掉常驻的横向音量滑杆：改成悬停音量按钮时在按钮上方弹出竖直滑杆（portal 到 HUD 内，绕开胶囊的 `overflow: hidden`），点击按钮仍然是静音/取消静音
- 滑杆让出的空间给标题：宽胶囊标题可用宽度变大；标题溢出时 hover 会来回滚动（GSAP timeline），不再弹原生 `title` tooltip
- 设置面板右上角的关闭（隐藏皮肤）按钮移除；隐藏皮肤现在只能走 `Cmd/Ctrl+Alt+B` 或命令面板
- 面板底部删除绿色状态点、「本地服务已连接/断开」、「测试声音」按钮
- 删除测试音相关逻辑：`/api/test-tone.wav|mp3`、`src/server/tone.ts`、Web Audio 振荡器、`canPlayType`/`MediaSource` 探测和对应日志

## 0.6.0

- 毛玻璃统一：迷你胶囊、宽胶囊、设置面板、登录弹窗都改用同一套 `--bili-glass-bg`（当前主题 `editorWidget` 背景色 72% + `blur(20px) saturate(1.25)`），不再是接近不透明的底色
- 拖动小屏框时面板进一步“透视”：模糊降到 7px、中心几乎透明，能直接看清背后被模糊的画面
- 新增「弹幕」开关（清晰度左侧、小屏设置旁边）：打开后按 `cid` 拉取整段弹幕，播放时把到时间的弹幕逐条打印到「Bilibili 皮肤」输出面板；拖动进度条/跳集不会补发历史弹幕
- 输出面板整理：时间改为本地 `HH:mm:ss` 并加分类标签 `[启动]` / `[皮肤]` / `[播放]` / `[弹幕]` / `[客户端]` / `[错误]`；客户端 `info` 级媒体事件只写日志文件，不再刷屏

## 0.5.2

- 拖动小屏框时，设置面板中间会“开个洞”：中心逐渐透明、向外回到面板底色，配合 `backdrop-filter` 能看到一点背后被毛玻璃模糊的画面（松手即恢复）
- 小屏设置页的高度锁定为切换前配置页的高度，不再把设置面板撑高/缩矮
- 配置页和小屏设置之间加了进场动效（淡入 + 轻微上移）
- 小屏设置入口按钮在打开时高亮（`aria-pressed` 主题色底）
- 移除小屏设置右上角的关闭按钮和底部「拖到边界会自动停住」提示行
- 小屏视频重新遵守「隐藏播放模式」：不再因为开着设置面板就常驻显示

## 0.5.1

- 「小屏」模式可用：视频变成编辑区里的一块小窗口，按视频宽高比锁定，可拖动位置、拖左下角缩放（右上角锚定）
- 选择小屏后，清晰度左侧出现「小屏设置」按钮：点击把设置面板分割线以下的区域切成编辑区缩略图，再点一次或按 X 退出
- 缩略图按编辑器实际宽高等比缩放，画出顶部的标签栏/面包屑和右侧代码地图禁入区（黄/红色块），小窗拖到边界会自动停住，进不去这两块区域
- 小屏位置写入 `bilibiliPlayer.miniRect`（归一化 0-1 比例），窗口缩放后自动按比例还原，宽高比始终不变
- 拖动/缩放时实时更新真实视频在编辑区里的位置

## 0.5.0

- 视频不再用 `object-fit` 铺满编辑区，也不再靠 `mix-blend-mode` 混掉黑边：改为按画面宽高比给 `<video>` 设宽高（宽度铺满编辑区，高度 = 宽度 ÷ 宽高比；放不下时按高度回缩），横向居中、顶部让出面包屑高度，视频以外的区域直接露出编辑器背景色
- 显示方式只保留「完整」和「小屏」；`cover` / `contain` / `fill` 统一迁移为「完整」，小屏逻辑暂未实现（选择后仍按完整显示并给出提示）
- 新增「移除黑边」开关（`bilibiliPlayer.cropBars`，默认开启）：扩展宿主用 ffmpeg 的 `cropdetect` 在视频里抽 5 段画面投票，得到画面真实宽高比后按内容比例排布，片源自带的黑边被裁到可视区外；关闭或探测失败时按视频原始比例显示
- 移除 `<video>` 上残留的 `mix-blend-mode: screen`、`object-fit` 变量和 `scale(1.02)`

## 0.4.23

- 设置面板首次加载时，标题/头像/时间/清晰度/选集/用户区域显示 skeleton，减少“未加载视频”占位造成的跳动
- 视频使用 `mix-blend-mode: screen` 与编辑器背景混合，源视频里烘焙的黑边会融入 `--vscode-editor-background`，不再显示纯黑
- 鼠标点击 HUD 按钮后不再残留 focus 边框（键盘 Tab 仍保留 focus-visible）

## 0.4.22

- 展开回宽胶囊时不再把其余内容藏起来：标题、音量、设置、关闭、收起按钮随胶囊宽度增长从右往左逐步揭开，避免动画结束后整块内容突然跳出

## 0.4.21

- 展开动画改为：点击 MoreHoriz 后图标立即变成播放/暂停按钮，随胶囊宽度增长从右往左移动，同时逆时针转 360°，宽度长完后再显示其余内容
- `object-fit: contain` / 铺不满时的黑边改为编辑器背景色（视频元素和视频层都使用 `--vscode-editor-background`），不再是黑色

## 0.4.20

- 宽胶囊按钮顺序改为：设置（最左）→ 关闭（中间）→ ChevronRight（最右）
- 宽胶囊新增静音按钮 + 52px 音量滑杆；标题相应收窄，截断时才挂原生 `title` tooltip
- 从迷你展开回宽胶囊时，MoreHoriz 图标在右侧反向旋转 760ms，宽度长完后再显示内容

## 0.4.19

- 宽胶囊在设置按钮左侧新增 `ChevronRight20Filled` 按钮，点击收起到迷你胶囊
- 移除“鼠标移开宽胶囊自动变迷你”的逻辑；宽/迷你现在完全由按钮控制（迷你里的 MoreHoriz 展开，宽胶囊里的 ChevronRight 收起）
- 使用 `@ricons/fluent` 的 `ChevronRight20Filled`，与图标名一致

## 0.4.18

- 加载视频/切换画质时，迷你胶囊的 MoreHoriz 图标、宽胶囊播放按钮、设置面板播放按钮统一显示 spinner
- spinner 覆盖 `loading` 和 `audioPreparing`（音轨转码/加载）两个阶段，音轨就绪后自动恢复播放图标

## 0.4.17

- 提示信息全部改走 **sonner**（不再放进设置面板，避免撑高面板）：加载视频/准备音轨用带 spinner 的 loading toast，错误 toast 自带「重试」，普通提示、自动播放拦截提示分别用 info/warning
- 修复音频已经出声但“正在准备音轨”一直不消失：新增 `audioReady`，音频 `canplay`/`playing`/`error` 时立即关闭 loading toast
- 设置面板删除 error/notice/audioBlocked 三个 alert 区块，面板高度更稳定
- sonner 的 CSS 由 esbuild 以文本方式打进 `skin.js`，不额外依赖运行时样式文件

## 0.4.16

- 设置面板收起/展开不再用 `scale` 压扁内容：改为只动画面板高度，内容保持原始布局，超出部分由 `overflow:hidden` 裁掉
- 展开时从胶囊高度向上长高，内容渐显；收起时高度缩到胶囊高度，内容渐隐

## 0.4.15

- 迷你胶囊的 MoreHoriz 按钮保持原来的圆形按钮样式（`bili-play-btn`），只替换图标和点击逻辑，不再使用透明方形图标按钮

## 0.4.14

- 迷你胶囊的按钮改为 MoreHoriz 三点图标（Tabler `Dots`），**点击**才展开为宽胶囊，悬停不再自动展开
- 宽胶囊只在鼠标停留时保持；移开 HUD 后自动收成迷你
- 宽胶囊 → 迷你胶囊的宽度动画从 460ms 放慢到 760ms，三点图标同步转一圈
- 修复从迷你展开时鼠标正好落在右侧 X 上导致误触隐藏的问题（展开后 400ms 内忽略 X）

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
