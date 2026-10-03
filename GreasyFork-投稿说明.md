# GreasyFork 投稿说明

本文件是提交到 GreasyFork 时需要的材料（名称、分类、描述、权限说明、截图建议）。
**提交前请务必阅读「注意事项」一节，涉及版权与条款。**

---

## 1. 基本信息

| 字段 | 值 |
|---|---|
| 脚本名称 | **DingTalk Live Replay Downloader** |
| 中文名称 | 钉钉直播回放下载器 |
| 版本 | 1.1.0 |
| 分类 | 实用工具 / 视频增强（multimedia/media） |
| 授权 | MIT |

## 2. 描述文案（可直接粘贴）

### 中文（推荐）

> 一键下载钉钉直播**回放**视频，无需登录。在钉钉直播回放页面上点击即可，可选输出 `.ts` / `.mp4`、并发线程数、重试次数。
>
> **原理**：通过公开接口获取回放 m3u8 播放列表，下载全部切片并在浏览器内完成拼接/转封装（TS 拼接或 mux.js 转 MP4）。
>
> - 无需登录钉钉账号
> - 自动识别页面中的 roomId / liveUuid，也可粘贴任意回放链接
> - 支持选择输出格式（.ts 最稳 / .mp4 实验性）、并发下载线程、重试次数
> - 自带进度显示，转封装失败自动回退为 TS，保证能出文件
>
> ⚠️ 本工具仅供学习与下载**自己有权留存**的内容，请勿传播或用于商业用途。输出 `.ts` 用 VLC/mpv/PotPlayer 播放。

### English

> Download DingTalk live **replays** with one click, no login required. Works on the replay page; choose output format (.ts / .mp4), concurrency and retry count.
>
> **How it works**: fetch the replay m3u8 playlist via a public API, download all segments, then concat (TS) or remux to MP4 in-browser via mux.js.
>
> - No DingTalk account needed
> - Auto-detects roomId / liveUuid from the page, or paste any replay link
> - Configurable output format, download concurrency, and retry count
> - Built-in progress; falls back to TS automatically if MP4 remuxing fails
>
> ⚠️ For personal learning and content you have the right to keep. Do not redistribute or use commercially. Play .ts output with VLC/mpv/PotPlayer.

## 3. 权限说明（GreasyFork 会要求解释）

| 权限 | 用途 |
|---|---|
| `GM_xmlhttpRequest` | 跨域请求 `lv.dingtalk.com`（取 CSRF、调接口拿播放地址）与 `dtliving-sz.dingtalk.com`（下载 m3u8 和 TS 切片）。油猴脚本跨域请求无法用普通 fetch 完成，必须用此 API。 |
| `GM_download` | 把拼接好的 Blob 保存为本地文件，`saveAs: true` 让用户自主选择保存位置。 |
| `GM_addStyle` | 为右下角下载面板添加样式。 |
| `GU_xmlhttpRequest` 不触碰页面数据 | 脚本只读取当前页 URL 的 query 参数（roomId/liveUuid），不读取、不上传任何页面内容或用户数据。 |

## 4. `@connect` 域名

```
lv.dingtalk.com
dtliving-sz.dingtalk.com
dtlive-sz.dingtalk.com
```

## 5. 截图建议

- 主截图：打开一个钉钉回放页，右下角出现下载面板，显示已识别 roomId / liveUuid。
- 进度截图：正在下载切片（显示 `xx/xx` 进度）。
- 完成截图：弹出「保存文件」对话框，文件名带 `.ts` 或 `.mp4`。

> 截图中**不要**出现课程标题/主播姓名等具体回放内容，以避免版权纠纷；建议用一个中性/你自己有权使用的回放页面截图。

## 6. 注意事项（提交前必读）

1. **版权与 ToS 风险**：脚本通过公开接口绕过 CDN 签名获取回放流。钉钉《用户协议》可能将「规避访问控制」列为违约；课程回放内容本身可能受版权保护。
   - GreasyFork 收到版权投诉会**下架脚本并可能封号**。
   - GitHub 可能收到 DMCA takedown。
2. **建议**：只做**技术中立**的表述（如本描述），不要在描述中提及任何具体课程、讲师或机构；只在你有权使用的内容上做演示截图。
3. **分发即传播**：公开脚本等于替别人方便地下载这些内容，请评估是否接受这一责任。

## 7. 提交入口

- GreasyFork：https://greasyfork.org/zh-CN/scripts/new —— 需要先注册账号，需提供可被脚本接受的**源码地址**（GitHub raw 或 `https://update.greasyfork.org` 同步源）。
- 推荐「从 GitHub 同步」：在 GreasyFork 脚本设置里填入 GitHub 仓库的 **raw 地址**，后续在 GitHub 改代码会自动同步，无需重复维护描述。
