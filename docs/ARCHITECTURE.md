# 架构与实现

目标：视频不是挤在侧边栏或标签页里，而是铺在 VS Code 工作台**最底层**，代码浮在视频之上。

v0.4.5 已按「工作台注入 + 直连播放」实现，并在 macOS + VS Code 1.147.0 上实测。

## 1. 路线选择

| 路线 | 是否真·皮肤 | 结论 |
| --- | --- | --- |
| **A. 工作台注入** | ✅ 视频在代码下面 | **采用** |
| B. Webview 播放器 | ❌ 独立区域 | 保留为安全模式 |
| C. 原生悬浮窗 | ❌ 覆盖在代码之上 | 不做 |

VS Code 没有「背景视频」API，`WebviewPanel` 只能是独立标签页，`WebviewView` 只能放侧边栏/面板区。因此真正的皮肤只能修改 workbench。

## 2. 注入点（实测 VS Code 1.147.0 / macOS）

- `appRoot`：`/Applications/Visual Studio Code.app/Contents/Resources/app`
- 工作台 HTML：`out/vs/code/electron-browser/workbench/workbench.html`
  （旧版本在 `electron-sandbox` 下，`locate.ts` 两种都会探测）
- `product.json` 的 `checksums` 覆盖 `workbench.html`、`workbench.js`、`workbench.desktop.main.js` 等 10 个文件

注入内容：

```html
<!-- bilibili-skin:head:start -->
<link rel="stylesheet" href="./bilibili-skin.css?v=..." />
<!-- bilibili-skin:head:end -->
...
<!-- bilibili-skin:body:start -->
<script src="./bilibili-skin.config.js?v=..." defer></script>
<script src="./bilibili-skin.js?v=..." defer></script>
<!-- bilibili-skin:body:end -->
```

- `?v=<timestamp>`：每次应用都换 URL，避免 Chromium 缓存旧皮肤（实测缓存会导致修改不生效）
- 3 个文件写到 workbench 同目录，满足 CSP `script-src 'self'`
- 配置里只放 `port` / `token` / `version`，不放用户数据

## 3. CSP

原始 `workbench.html` 的限制：

```
media-src  'self'
frame-src  'self' vscode-webview:
script-src 'self' 'unsafe-eval' blob:
require-trusted-types-for 'script'
```

`csp.ts` 在原有指令上追加（保留其余指令与格式）：

```
media-src    https://*.bilivideo.com https://*.bilibili.com blob:
connect-src  http://127.0.0.1:* http://localhost:*
frame-src    https://player.bilibili.com
```

- 不放开 `script-src 'unsafe-inline'`
- HUD 不使用 `innerHTML`，兼容 `require-trusted-types-for 'script'`

## 4. 校验和（关键坑）

`product.json.checksums` 的值是 **sha256 后去掉 `=` 填充的标准 base64**。如果按普通 base64（带 `=`）写回，会导致「Your Code installation appears to be corrupt」。

- `checksums.ts` 的 `sha256Base64()` 使用 `.replace(/=+$/, '')`
- `applyPatch` 写入 `workbench.html` 的新哈希并备份原 `product.json`
- `restorePatch` 恢复原始 CSP 和 `workbench.html`，并重算校验和
- `fixChecksums` 用于残留的「其它工具改过文件」场景（例如手动注入过 `workbench.js`）：重算所有不匹配项，备份 `product.json.bilibili-backup`

实测：把 `workbench.html` 与 `workbench.js` 的校验和都修正后，重启 VS Code 不再出现「安装已损坏」提示。

## 5. 透明工作台

注入的 CSS 让工作台各层透明，视频层在 `z-index:-1`：

```css
body.bili-skin-on,
body.bili-skin-on .monaco-workbench,
body.bili-skin-on .monaco-workbench .monaco-grid-view, /* 1.147 新布局，关键 */
body.bili-skin-on .monaco-workbench .monaco-grid-view .split-view-view,
body.bili-skin-on .monaco-workbench .part.editor,
body.bili-skin-on .monaco-workbench .monaco-editor,
body.bili-skin-on .monaco-workbench .monaco-editor .monaco-editor-background,
body.bili-skin-on .monaco-workbench .monaco-editor .margin {
  background-color: transparent !important;
}
```

- VS Code 1.147 的 `.monaco-grid-view` 默认是 `rgb(25,26,27)` 不透明全屏容器，不覆盖它视频就会被完全挡住（调试时踩过）
- 只有编辑区透明；侧边栏、终端、状态栏保留主题背景，正常遮挡视频
- 视频层跟随 `.part.editor > .content` 的矩形定位（见第 11 节），`object-fit` 可调，`opacity`/`blur` 由 HUD 控制
- 暗化层叠加的是 `--vscode-editor-background`，100% 时与未开皮肤时的编辑区颜色一致，而不是黑色
- 吸顶滚动（sticky scroll）的 `editorStickyScroll` 背景、边框和阴影统一置为透明，否则滚动到方法内部时会在编辑区顶部盖出一条横带
- 视频层 `pointer-events: none`，不影响代码点击

## 6. 播放链路

```
HUD → fetch 127.0.0.1:17321/api/play
    → 扩展宿主 BiliClient
        GET api.bilibili.com/x/web-interface/view      (bvid → cid/title)
        GET api.bilibili.com/x/player/playurl          (fnval=1&platform=html5&qn=...)
    ← data.durl[0].url / backup_url
HUD 设置 <video src="https://*.bilivideo.com/....mp4">
```

- 请求头带 `Referer: https://www.bilibili.com/`、桌面 UA、登录 Cookie
- 实测 CDN 支持 Range 且不强制 Referer；媒体流**不经过本地服务器**，省带宽、无代理的 Range/超时问题
- `platform=html5` 让 B 站返回 mp4，而不是浏览器不能播的 FLV
- 地址有时效；`onError` 先切 `backup_url`，再提示重试

清晰度：≤720P 用 `fnval=1` durl（自带音轨）；请求 1080P/1080P+ 时同时请求 `fnval=16` DASH，若 DASH 实际清晰度高于 durl，则使用 DASH 的视频轨 + 独立 AAC 音轨，两个原生媒体元素同步播放。登录/退出会递增 `authRevision`，HUD 自动重拉 playurl 刷新列表；选择不可用档位会显示回落提示。

## 7. 上下集与合集

`view` 返回：

- `pages[]`：多 P 视频，每个 P 有 `cid/page/part`
- `ugc_season.sections[].episodes[]`：B 站合集/season，每个 episode 有 `bvid/cid/title/page`

`getPlayInfo()` 把它们统一成 `episodes[]`，并计算当前 `episodeIndex`。HUD 在集数 > 1 时显示上一集/下一集和选集下拉；切换时用目标 `bvid + page` 重新请求 playurl，并同步皮肤状态。

## 8. 扫码登录

```
HUD 点击「扫码登录」
  GET /api/login/qr
    → passport.bilibili.com/x/passport-login/web/qrcode/generate
    → qrcode.toDataURL() 返回 data:image/png
  HUD 每 2s GET /api/login/poll?key=...
    → code 86101 未扫码 / 86090 已扫码 / 0 成功 / 86038 过期
    → 成功后读取 Set-Cookie，存 context.secrets
    → GET api.bilibili.com/x/web-interface/nav 获取用户名/头像/VIP
```

Cookie 只存本地 `SecretStorage`；HUD 只拿到 `{ name, face, vip }`，不暴露 SESSDATA。

## 9. 本地 API 与安全

- 只监听 `127.0.0.1`，端口 17321–17330（多窗口/端口占用自动顺延）
- 每个请求校验 `x-bili-token`（随机 24 字节 hex，存 `globalState`，并写入 workbench 同目录的 config 供 HUD 读取）
- CORS 允许 `vscode-file://` 页面并处理 `OPTIONS` / Private Network Access
- 端口发现：HUD 从 config 的端口开始，失败后扫描 17321–17330，适配多窗口
- 登录态失效时 HUD 显示未登录，不影响未登录播放

## 10. 主题适配与动画

HUD 的颜色不写死，统一在 `tailwind.css` 的 `.monaco-workbench` 上定义一层 `--bili-*` 变量，值全部引用 VS Code 当前主题的 `--vscode-*`。注意：VS Code 把主题变量定义在 `.monaco-workbench` 而不是 `body`，所以 HUD/视频层必须挂到 workbench 内部，Radix Portal 也必须指定 HUD 作为容器：

| 用途 | 变量 |
| --- | --- |
| 文字 | `foreground` / `descriptionForeground` / `disabledForeground` |
| 面板背景 | `editorWidget-background`（94% 不透明 + backdrop blur） |
| 边框 | `input-border` / `dropdown-border`（回退 `panel-border`）；避开 Dracula 过亮的 `panel.border` |
| 按钮/滑杆 | 主色用 `activityBarBadge-background`；文字 `activityBarBadge-foreground`；回退 `badge-*` / `focusBorder`；次要按钮 `button-secondary*` |
| 输入/下拉 | `input-background` / `input-foreground` / `input-border` / `dropdown-*` |
| 焦点/选中 | `focusBorder` / `list-activeSelection*` / `list-highlightForeground` |
| 错误/警告 | `inputValidation-error*` / `inputValidation-warning*` / `errorForeground` |

因为 HUD、视频层和 Radix Portal 都在 `.monaco-workbench` 内部，变量可直接继承；主题切换时浏览器会实时重算，无需重载。唯一保留 B 站粉的是「大会员」标签（`.bili-vip`）。

收起/展开不使用简单的 fade：面板内容先 `filter: blur()`，面板以右下角为原点从胶囊矩形 `scale` 到完整尺寸，结束后清掉模糊；收起是相反过程，切换成胶囊后再解除模糊。

## 11. 音频生命周期

DASH 的独立音轨最容易出“双音轨”问题：`load()` 开始时先 `pause()` 旧 audio，但 250ms 同步循环会发现 video 在播放、audio 被暂停，从而再次 `play()`；等新 `audioSrc` 挂载后，旧 audio 已被 React 卸载，却可能作为 detached element 继续出声。

现在的约束：

- `load()` 开始立即 `pause()` + `setAudioSrc(null)`，把旧音轨卸载，并用 `audioSwitching` 阻止同步循环重新播放
- 请求带 `loadSeq`，旧响应不会覆盖新音轨
- 新 `audioSrc` 挂载后强制 `audio.load()`，再恢复同步
- 隐藏皮肤时媒体元素保持挂载、`display:none` 且暂停，避免卸载产生幽灵音频

## 12. 视频范围与 HUD 定位

视频层不是全窗口，而是跟随 `.monaco-workbench .part.editor > .content` 的 `getBoundingClientRect()`，通过 `left/top/width/height` 固定定位；`ResizeObserver` + 每秒兜底测量处理侧边栏、终端、聊天栏、窗口缩放。HUD 宿主 `#bili-skin-hud` 的 `right/bottom` 也按编辑区计算，贴在编辑区右下角。侧边栏/面板/状态栏恢复主题不透明背景，自然遮挡视频。

## 13. 注入生命周期

- **应用**：确认弹窗 → 备份 `workbench.html` / `product.json` 到 `globalStorage/workbench-backups/<version>/` → 重写 CSP → 注入 → 写 3 个资源 → 更新校验和 → 可选立即重载
- **更新皮肤**：重复应用会先剥离旧块（幂等），换 `?v=`，重新写入
- **还原**：剥离注入块、按 sidecar 恢复原始 CSP、写入原 HTML 等价内容、重算校验和、删除皮肤文件
- **VS Code 升级后**：HTML 被覆盖，`isPatched` 返回 false；用户重新应用即可。旧资源文件残留无害，会被覆盖
- **旧手动补丁**：检测 `#bilibili-background-video`（之前注入 workbench.js 的后台视频），显示期间 `display:none`，隐藏时恢复

## 14. 安全与合规

- 只在用户显式执行「应用皮肤」时修改安装目录，首次弹确认
- 修改前备份，一键还原
- 不提供下载/缓存/转码；不绕过付费/会员内容
- 修复校验和需用户显式确认，并说明用途
- 若上架扩展市场：默认安全模式，注入模式需用户手动开启，并在 README 说明风险
