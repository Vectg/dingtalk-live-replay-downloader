# dingtalk-live-replay-downloader

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-blue)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A Tampermonkey userscript that downloads DingTalk live replays **without logging in** — fetches the replay m3u8 playlist through public APIs, downloads every segment in the browser and assembles one file.

通过公开接口获取钉钉直播**回放**的 m3u8 播放列表，浏览器内下载全部切片并拼成一个文件。**无需登录钉钉账号**，在回放页点一下即可。

> Only download content **you have the right to keep**. 仅用于下载你有权留存的内容。

---

## 功能（v1.9.8）

**核心**

- **无需登录**：`csrf` → `getOpenLiveInfoV2` 取带签名的播放地址，全程匿名。
- **输出 MP4（默认）/ TS**：`.mp4` 由 `mux.js` 在浏览器内转封装；`.ts` 为原始拼接，兼容性最好。
- **分辨率选择**：多档播放列表自动识别（默认「自动」= 最高带宽 = 原始分辨率），预取后回填各档位（含码率），切换即重新预取；选择持久化。**单档 TS 自动分析原始分辨率**——Range 拉首片前 64KB，TS 解包 → H.264 SPS 解析（支持 Baseline/Main/High、裁剪参数），下拉第一项直接显示 `自动（原始分辨率 1280×720）`，历史日志含 `H.264 Main @3.1` 等 profile/level 细节（真实回放实测）。
- **MP4 时长与进度条已修复**：`mux.js` 输出的 `moov/mvhd/mdhd` duration 写成 `0xFFFFFFFF`（unknown 哨兵），播放器会显示成十几小时、拖不动进度条、画面卡死。脚本遍历 `moof` 用 `tfdt + Σtrun` 算出真实时长写回，30 分钟回放即显示 30 分钟，文件大小不变。
- **失败诊断**：切片失败时状态栏给出一行总结（序号 + 原因 + 排查建议），按错误类型区分（401/403 签名过期、404 回放已清理、其他降并发/更新脚本）。
- **输出历史**：状态栏默认只显示最新一条；**点击状态栏**展开查看全部历史日志（最多 300 条、可滚动），再点收回。完整句子自动换行，不裁字。
- **进度动画**：进度条 + 状态栏完整显示（不裁字，可换行），实时显示当前阶段与 `n/N`。
- **体积预估（v1.9.7）**：下载前用 `Range: bytes=0-0` 只拉首片 1 字节读 `Content-Range` 得单片总大小，`单片 × 片数` 得出总大小（不额外下载整片），解析阶段日志显示 `预计体积: 约 340 MB（单片 5.8 MB × 60 片）`；下载中进度条追加 `已下/预计` 字节数。探测失败时静默跳过，不影响下载。
- **完整性校验（v1.9.7）**：全部切片下载后逐片校验——数量齐全、非空、TS 同步字节 188 周期对齐（在首 188 字节内找对齐点，兼容带 ID3/填充前缀的合法切片；HTML 错误页与截断数据会被识破）。通过则日志 `✅ 完整性校验通过：60/60 片 · 341.2 MB`；发现异常则**只把问题片置空、好片保留为断点缓存**，报出具体片号，点下载只补异常片，不用重下整个回放。
- **链接解析修复（v1.9.8）**：粘贴不带域名的裸查询串（`?roomId=…&liveUuid=…`）时不再报「链接缺少 roomId/liveUuid」——旧代码在回退拼接时会把开头的 `?` 再拼一个，导致参数名带上多余问号而取不到。

**性能与预取**

- **预取播放信息**（更多设置，默认开启）：打开回放页即在后台预取 csrf → 播放地址 → m3u8 切片索引，缓存 10 分钟。点「下载本页回放」直接进入切片下载阶段，省掉每次 1~3 秒的解析等待。文件名输入框的 placeholder 会直接回填为解析出的回放标题。
- **并发线程自动识别**：默认按 CPU 逻辑核数 ×2 推算（4~16 封顶），网络 IO 密集场景下比固定 5 线程更快；「更多设置」里的说明文字会直接显示本次识别到的线程数。手动改过之后以你的设置为准，选择持久化（`GM_setValue`），刷新后保留。

**下载控制**

- **暂停/继续**：下载中显示控制条，暂停后进度完全冻结，继续从原位推进。
- **中断**：停止本次下载，已下载切片保留为断点缓存；再点下载自动**断点续传**（日志 `♻ 命中断点缓存`），不会重下。**缓存同时写入 IndexedDB（v1.9.6 起）——刷新页面、关闭标签页后重开，依然能续传**，日志显示 `♻ 命中跨会话断点缓存`；下载成功或点「删除已下载」时同步清空。
- **删除已下载**：下载中一键放弃并清空全部切片缓存（含 IndexedDB），下次从头开始。
- **实时速度与预计剩余时间**：进度条显示 `切片 6/12 · 1.2 MB/s · 剩 00:01`（EMA 平滑）。

**下载后处理**

- **自定义文件名**：面板可直接填写输出文件名，**留空则自动使用回放标题**（placeholder 即回放标题）；误带的 `.mp4`/`.ts` 后缀会自动去掉。勾选「文件名加时间戳」后，placeholder 自动追加 `_时间戳` 且每秒刷新。
- **截取时长**：只下载「开始 → 结束」区间内的切片，留空即整段；按切片边界对齐（约 30 秒粒度）。输入校验：自动修复中文/全角冒号与全角数字；拒绝乱码、四段冒号、秒位 >59、开始 ≥ 结束；结束超出总时长自动截到末尾并提示。
- **内置预览**：MP4 下载完成后可在面板内直接播放，支持**倍速**（0.5×–2×）与**音量**控制。
- **文件名加时间戳**。

**面板外观**

- **毛玻璃**：默认**关闭**（v1.8.0 起）。开启后面板与**收起的横条**均为半透明 + 背景模糊（`backdrop-filter`），可透出底层播放器画面；状态持久化，刷新后保留。毛玻璃态下页脚小字自动**提亮 + 文字阴影**，底层画面再亮也读得清（v1.9.5 修复）。
- **更多设置**：面板底部的可折叠区，**默认收起**，收纳低频选项——并发线程、重试次数、**面板状态（默认展开/收缩）**、预取播放信息、毛玻璃、**自动检查更新（默认开启）**。前两项的取值与所有开关状态均持久化（`GM_setValue`），刷新后保留；手动收起/展开会同步「面板状态」。**面板状态读取做了归一化**：历史版本存过的布尔、数字、字符串杂散值（`true`/`1`/`'true'`）都能正确识别，首启自动统一成规范格式，下拉框始终与面板实际状态一致（v1.9.3 修复「实际收缩却显示默认展开」的错位）。展开/收起箭头为 CSS chevron（90° 平滑翻转），带 260ms 弹簧缓出过渡。
- **收缩为横条**：不看面板时点「收起」，缩成右下角**横向长条**（上行=回放标题，下行=进度条），不挡画面；点条展开，状态持久化。进度条**解析阶段为蓝色、下载阶段为绿色**，下载中也可收起随时盯进度。收起/展开用 `grid-template-rows:1fr→0fr` 做**高度平滑折叠**（内容与外壳走同一条 280ms `cubic-bezier(0.16,1,0.3,1)` 弹簧曲线，宽高透明度完全同步），并尊重系统「减少动态效果」设置。
- **下载光环**：下载进行时，面板最外层有一圈流动的渐变光带（蓝→青→粉，亮段沿边缘流动）。用 SVG 圆角矩形 + `stroke-dash` 实现，3s 慢速、不翻转；中间完全不涂色，**不会透进面板内部糊成色块**。收缩成横条时光环同样包住。
- **不再弹保存对话框**：点下载后直接交给浏览器存到默认下载文件夹（`saveAs:false`）。旧版弹的系统对话框在油猴里点「取消」不会回传任何回调，无法可靠判断，会造成「点取消却仍在下载」。现在无对话框、无需取消判断，完成状态栏会提示「已存入浏览器默认下载文件夹」。
- **深色主题**：面板、输入框、按钮均为深色，暗光环境下不刺眼。

**版本与更新**

- 面板底部版本号旁是灰色小字「检查更新」（v1.9.4 起不再是按钮）：**自动检查默认开启**（更多设置可关），打开页面后在后台比对 GitHub 最新版本，发现新版时该处变为蓝色可点的「发现新版 x.y.z ↑」——**不会自动跳转，点击才打开更新页**。关闭自动检查后，点「检查更新」手动比对，看到「发现新版」再点一次才跳转下载。已是最新/检查失败会短暂显示后复原。**GitHub 不通时自动回落到 Gitee 镜像**。

**协议兼容**

- **多码率**：遇 `#EXT-X-STREAM-INF` 自动选最高带宽递归。
- **AES-128**：遇 `#EXT-X-KEY` 用 Web Crypto 拉 key 逐片解密。
- **fMP4 / BYTERANGE**：支持 `#EXT-X-MAP` 初始化段与 `#EXT-X-BYTERANGE` 字节范围。
- **并发**（1–16，默认自动识别 = CPU 逻辑核数 ×2，手动设置后以设置为准）与**重试**（1–10，默认 3，指数退避）。

---

## 安装

1. 安装 [Tampermonkey（油猴）](https://www.tampermonkey.net/)。
2. 打开下面的 Raw 地址即可触发安装页（GitHub 与 Gitee 二选一）：

   ```
   https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   国内访问慢可改用 Gitee 镜像：

   ```
   https://gitee.com/Vectg/dingtalk-live-replay-downloader/raw/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   脚本带 `@updateURL` / `@downloadURL`，**装过一次后可直接在油猴里「检查更新」自动升级**，或用面板内的「检查更新」按钮。

3. 在 Edge / Chrome 还需到 `edge://extensions/`（或 `chrome://extensions/`）→ 篡改猴 → 详细信息，打开 **「允许用户脚本」**。此开关默认关闭时，油猴脚本一行都不会执行，右下角不会出现面板。

> 面板不出现时：确认开关已开 → 油猴里脚本为启用状态 → 回放页 `Ctrl+F5` 强刷 → F12 Console 看报错。

---

## 使用

1. 打开回放页（`n.dingtalk.com/dingding/live-room/index.html?roomId=...&liveUuid=...`），右下角出现面板并自动读出链接。
2. 按需设置：**文件名**（留空用回放标题）、**输出格式**、**截取时长**（`mm:ss` 或 `hh:mm:ss`，留空为全部）、并发、重试。
3. 点「下载本页回放」，状态栏依次显示：取 token → 播放地址 → m3u8 → 切片 `n/N` → 拼接 → 保存；面板外右下角会有旋转光圈提示进行中。
4. MP4 下载完成后面板内直接出现**预览播放器**，可调倍速与音量；同时弹出保存对话框。
5. 不用时可点「收起」把面板缩成右下角小图标，需要时点图标展开；下载进行中光圈始终可见。
6. 也可把任意回放链接粘贴进输入框再点下载，不必停留在该页。

也可以把 `.ts` 交给 ffmpeg 重封装：

```bash
ffmpeg -i in.ts -c copy -bsf:a aac_adtstoasc out.mp4
```

Windows 下中文文件名/引号易出问题，建议用 Python `subprocess.run([...])` 传参，或先改 ASCII 临时名。

---

## 原理

- `GET https://lv.dingtalk.com/csrf` —— **绝不能带 Origin 头**，否则返回 403 `Invalid CORS request`；拿到 token 与 `XSRF-TOKEN` cookie。
- `POST https://lv.dingtalk.com/getOpenLiveInfoV2` —— body 是**单个对象** `{roomId, liveUuid}`，且必须同时带 `XSRF-TOKEN` cookie 与 `X-XSRF-TOKEN` 头（同一 token）→ 返回 `openLiveDetailModel.playbackUrl`（带签名的 m3u8，约 10 天有效）。
- 解析 m3u8 得到带各自签名的切片 URL，并发下载后按顺序字节拼接。
- `getOpenLiveInfo`（V1）对匿名用户 `playbackUrl` 是**空字符串**，必须用 V2；`sliceCount`/`sliceDuration` 是雪碧图参数、**不是**切片数，以 m3u8 实际条目为准。
- **MP4 duration 修补**：`mux.js` 面向 MSE 流式播放，`moov` 里 `mvhd/tkhd/mdhd` 的 duration 留为 `0xFFFFFFFF`。脚本遍历 `moof/traf`，用 `tfdt + Σtrun.sample_duration` 算出每轨真实结束时间，换算 timescale 后写回；媒体数据本身不变、文件大小不变。

---

## 开发

```bash
git clone https://github.com/Vectg/dingtalk-live-replay-downloader.git
cd dingtalk-live-replay-downloader
node test/run.js
```

测试不从副本跑：`test/extract.js` 直接从**已发布的 `钉钉直播回放下载.user.js`** 里按函数名抽取源码执行，所以测的就是用户真正装到 Tampermonkey 里的那份代码，不会出现「测试通过但发布出去是另一份实现」。抽取按花括号配平并跳过字符串/正则/注释，`test/run.js` 开头还会自检抽取结果是否完整可编译。

覆盖范围：m3u8 解析（多码率选档 / AES-128 / `EXT-X-MAP` / `EXT-X-BYTERANGE` / 时间轴累加）、MP4 `fixMp4Duration`（哨兵 duration 修补，含 moof 缺失与已正常两种边界）、H.264 SPS 分辨率解析（Baseline / High 扩展路径 / `frame_cropping` / MBAFF / 上下限边界）、截取区间对齐、体积与时间格式化、版本比较、URL 解析。

GitHub Actions 在每次 push / PR 上跑三项：`node --check` 语法检查、`test/run.js` 单元测试，以及 `test/version_guard.sh` —— 最后一项会在「改了 `.user.js` 却没 bump `@version`」时让 CI 失败（这个坑在 1.6.8 踩过一次：修复发布了，但版本号没涨，Tampermonkey 用户根本收不到更新）。

---

## 已知限制

- 截取按切片边界对齐（约 30 秒粒度），非帧级精确。
- 预览的**倍速/音量只作用于面板内播放**，不改变已保存的文件——改写音频音量或播放速度需重新编码，浏览器内无法可靠完成；需要这类处理请把 `.ts` 交给 ffmpeg。
- `.ts` 无法在浏览器 `<video>` 内预览（Chromium 不解码 MPEG-TS），需 VLC / mpv / PotPlayer，或改选 MP4。
- 回放签名约 10 天有效，过期后重新点一次下载即可。
- 已授权 `@connect *`：HLS CDN 域名随回放变化（`dtliving-sz.dingtalk.com`、`dtlive-sz.dingtalk.com` 等），故放开为任意域名；介意可改成具体域名自行补充。
- 权限仅 `GM_xmlhttpRequest`（跨域请求）、`GM_download`（保存文件）、`GM_addStyle`（面板样式）、`GM_getValue`/`GM_setValue`（记住毛玻璃与收缩状态）；脚本只读当前页 URL 的 query 参数，不读取、不上传任何页面内容。

---

## 版权提示

脚本通过公开接口获取回放，**绕过 CDN 签名**。钉钉《用户协议》可能将「规避访问控制」列为违约，回放内容本身可能受版权保护。仅用于下载**你自己有权留存**的内容，请勿传播或用于商业用途。

---

## License

[MIT](LICENSE)
