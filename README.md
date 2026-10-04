# dingtalk-live-replay-downloader

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-blue)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Changelog](https://img.shields.io/badge/CHANGELOG-3.0.1-informational)](CHANGELOG.md)

A Tampermonkey userscript that downloads publicly accessible DingTalk live replays **without logging in** — it fetches the replay m3u8 playlist through public APIs, downloads every segment in the browser and assembles one file.

通过公开接口获取钉钉直播**回放**的 m3u8 播放列表，浏览器内下载全部切片并拼成一个文件。**无需登录钉钉账号**即可下载公开可访问的回放，在回放页点一下即可。

> Only download content **you have the right to keep**. 仅用于下载你有权留存的内容。

**中文（默认）** ｜ [English](#english-version)

---

## 功能（v3.0.6）

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
- **帧级精确截取（v2.5.0 优化入口，实验性，默认关）**：更多设置里开启。切片对齐只能精确到切片长度（通常 30 秒），开启后会在切片对齐的基础上再做一次精修：逐帧解析视频流找出全部关键帧，把起止点对齐到离目标最近的 IDR。**因为帧级精修需要完整切片集才能建立时间轴基准，启用时会先下载完整回放再裁剪**（多花一点流量和时间，但换来的精度是切片对齐做不到的）。中途切出的流会重新封装 SPS/PPS 并插入输出开头，否则播放器找不到解码参数、开头若干帧会解码失败。fMP4 回放不支持（没有 TS 包结构）；解析不到足够关键帧时自动退回切片对齐结果，绝不会因为「想更精确」而让用户拿不到文件。**v2.5.0 起在截取区加了醒目指引**：不知道这个功能的人直接点提示行里的蓝色「点这里打开『帧级精确截取』」，会自动展开「更多设置」并让那个开关闪两下，不必自己去找。开关标题写明「默认关」及开启代价。
- **智能调度（v2.1.0）**：更多设置里开启（默认开）。两件事一起做——**贪心取片顺序**：抽样探测头尾各若干片的真实体积（1 字节 Range，不下载整片），体积大的先下，让最长的那根线尽早启动，压缩整体完成时间；**并发自适应**：从你设定的线程数起步，连续成功就逐级加到 16，一旦有切片失败立刻降并发退避，恢复后再爬回去。切片体积探不到（探测失败或 BYTERANGE 分片）时自动退回原序下载，不影响功能。日志会报告抽样情况与最终并发。关掉后并发固定为设定值，行为与 1.9.x 一致。
- **解析后后台预下载（v2.7.0）**：打开回放页后，解析出切片列表的那一刻就在后台静默下载切片（弱并发 2，不抢带宽），日志提示 `✓ 后台预下载完成 12 片 · 441 KB，现在点下载只需合并保存`。等你想好要下的时候，点下载几乎瞬间完成。更多设置里可关（默认开），关掉后行为与 2.6.x 完全一致。**预下载只存内存不落盘**——刷新页面即丢弃，不会产生「删不掉」的幽灵缓存。点「中断」或「删除已下载」会一并清掉。
- **下载队列（v2.0.0）**：链接输入框下方可填多行队列（每行一个回放），点「▶ 开始队列」按顺序依次下载完。行格式宽松——整段链接、裸查询串、`roomId liveUuid`、`roomId=liveUuid liveUuid=…`（从聊天记录复制时最常见的形式）都能识别；空行与 `#` 开头的注释行忽略，无法识别的行会单独报出并指出是第几行。**单个回放失败不会中断整队**——排了 5 个、第 3 个签名过期，4 和 5 照常跑完，最后汇总「成功 N · 失败 M」。刻意做成顺序执行而非并发：并发多个回放只会让它们互相抢带宽、一起变慢，用户要的是「一次挂几个」而不是「一起抢」。
- **导出 m3u8 播放列表（v1.9.12）**：面板底部「📄 导出 m3u8」把当前选中分辨率的切片列表存成标准播放列表，便于用 VLC / ffmpeg / 其他下载器重新拉取或存档。严格按 HLS 规范输出——`TARGETDURATION` 向上取整到最长片、`EXTINF` 与切片 URL 严格交替、`EXT-X-MAP` 在首个 `EXTINF` 之前、`BYTERANGE` 在其切片 URL 之前、AES-128 时带 `KEY` 声明（含 IV）、结尾 `EXT-X-ENDLIST`。刻意不加 BOM：部分解析器会把带 BOM 的首行当成标签名。已用 ffmpeg 实测可正常识别（时长与切片数完全吻合）。
- **一键导出诊断日志（v1.9.11）**：面板底部「📋 导出诊断日志」生成 `.txt`，包含脚本版本、浏览器 UA、硬件并发与自动识别的线程数、解析结果（切片数/时长/加密/fMP4/多码率档位）、缓存与待重试片号、各项设置、每次下载的成败结论，以及**页面未捕获的异常与 Promise 拒绝**。播放地址里的签名（`auth_key`/`token`/`sign`/`signature`，含大小写变体）会被自动抹除——诊断文本常被直接贴到公开 issue 里，不抹除等于泄露一次性凭证。
- **自定义分辨率（v1.9.11）**：分辨率下拉除播放列表声明的档位外，还列出**不超过原始分辨率**的常用档位（4K/1440p/1080p/900p/720p/540p/480p/360p/270p）；末尾的「自定义…」可手填 `宽x高`，支持 `1920X1080`、`1920×1080`、全角数字与中文冒号等常见手打写法。填的值会匹配到播放列表里最接近的真实档位——**匹配不到正好这一档时会明确告知实际用了哪一档**，不会让用户以为下了自己没填的分辨率。没有可用档位则如实说明并回到「自动」。
- **自选更新源（v1.9.11）**：更多设置里可切换 **Gitee（默认）/ GitHub / 自动**。默认 Gitee——`raw.githubusercontent.com` 在国内时通时不通，Gitee 镜像通常稳定。切换后立即按新源重新检查一次，「发现新版」的跳转链接也跟着走对应源。
- **只重试失败切片（v1.9.10）**：下载或完整性校验失败后，面板下方出现「♻ 只重试失败切片」按钮，旁边写明上次失败了几片、具体片号（例如「上次失败 2 片（#3 #6），其余切片已缓存」）。点它**只补这几片**，已下好的片绝不再下一遍——重试用的是 1.9.6/1.9.7 建立的 IndexedDB 断点缓存，跨刷新、关页后依然有效。换分辨率或点「删除已下载」会清掉该按钮，避免拿上一轮的数字误导。
- **完成/失败通知（v1.9.9）**：下载结束（成功保存、或失败报错）时可选弹系统通知——标题点明成功/失败，正文带文件名与体积（失败时带具体原因与建议，点击通知可回到面板）。提示音用 WebAudio 现场合成（完成两声上行、失败三声下行），不带外部音频文件。两个开关都在「更多设置」里，且**默认都关闭**——浏览器自动播放策略常拦未交互页面的声音，声音默认开容易让人以为坏了；AudioContext 已在点「下载」时预热以缓解该策略。需要时自行打开即可。
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
- **截取时长（v2.3.0 起自动识别单位）**：只下载「开始 → 结束」区间内的切片，留空即整段；按切片边界对齐（约 30 秒粒度）。**时间框不再预设格式**——解析出回放总时长后自动告诉你上限：总时长不足 1 小时给 `mm:ss`，达到 1 小时及以上自动换成 `hh:mm:ss`（小时位不限 99，可填 `100:00:00`），框内灰字提示随总时长实时变化。**失焦自动补零**（`1:2:3` → `01:02:03`），全角数字/中文冒号/空白/零宽字符照旧自动修复。两段写法（如 `1:30`）不做猜测性改写——它在 `mm:ss` 与 `hh:mm` 之间天然歧义，一律按 `mm:ss` 解析并在超限时给出可用写法。结束超出总时长自动截到末尾并提示。
- **内置预览**：MP4 下载完成后可在面板内直接播放，支持**倍速**（0.5×–2×）与**音量**控制。
- **文件名加时间戳**。

**面板外观**

- **开启毛玻璃效果**：默认**关闭**（v1.8.0 起）。开启后面板与**收起的横条**均为半透明 + 背景模糊（`backdrop-filter`），可透出底层播放器画面；状态持久化，刷新后保留。毛玻璃态下页脚小字自动**提亮 + 文字阴影**，底层画面再亮也读得清（v1.9.5 修复）。
- **面板可拖拽（v2.4.0，v2.6.0 修复）**：按住面板标题区（光标变抓手）即可拖到任意位置，位置自动记住（刷新后还在）。**收起成横条后同样能拖**（v2.6.0 修复，此前收起后完全拖不动）。**只有按在空白处才触发拖拽**——落在输入框、下拉框、按钮上时浏览器原生行为照旧（v2.6.0 修复，此前拖拽区圈住了整个表单，导致所有输入框和下拉框都点不动）。**横向**夹在可视区内防止面板拖丢；**纵向**允许拖出视口——面板展开后往往比窗口还高（600px+），强行夹住会永远贴死在顶部、看着像「拖不动」。 **v3.0.3 修复**：原先横向钳制只在拖动那一刻算一次，窗口缩小后没人重算——把面板拖到最右再缩窗口，面板会有一大半（实测 392px 宽的面板有 240px）跑到屏幕外，鼠标再也点不到、只能刷新页面找回。现窗口缩放时按上次坐标重新钳制一次，反复缩放也不会累积漂移。
- **键盘快捷键（v2.4.0）**：`空格` 开始下载 / 下载中暂停继续（同一键随状态切换）、`Esc` 下载中立刻中断、空闲时收起或展开面板、`M` 切换收起。**在输入框里打字时一律不拦截**，不会因为想输个 `m` 就把面板收起。
- **拖动时自动收起设置（v2.6.0）**：更多设置里可开关（默认开）。拖动面板时自动折叠「更多设置」与输出预览区，拖完自动恢复原状态——折叠区在拖动过程中只会碍事。不想这个行为可以在更多设置里关掉。
- **面板视口自适应（v2.6.1）**：面板高度上限跟随窗口可用高度（`100vh - 140px`），超出部分在面板内滚动。**无论窗口多矮，全部展开也不会超出屏幕边界**——实测 700px 高的窗口下面板为 678px，正常笔记本视口完全够用，不必再为「设置展开后顶出屏幕」操心。
- **更设置更紧凑（v2.6.0）**：数字输入框与下拉框两两并排一行，八个开关排成两列网格，整体高度比之前矮一半，不用再滚动半天找选项。
- **更多设置**：面板底部的可折叠区，**默认收起**，收纳低频选项——并发线程、重试次数、**面板状态（默认展开/收缩）**、预取播放信息、毛玻璃、**自动检查更新（默认开启）**。前两项的取值与所有开关状态均持久化（`GM_setValue`），刷新后保留；手动收起/展开会同步「面板状态」。**面板状态读取做了归一化**：历史版本存过的布尔、数字、字符串杂散值（`true`/`1`/`'true'`）都能正确识别，首启自动统一成规范格式，下拉框始终与面板实际状态一致（v1.9.3 修复「实际收缩却显示默认展开」的错位）。展开/收起箭头为 CSS chevron（90° 平滑翻转），带 260ms 弹簧缓出过渡。
- **收缩为横条**：不看面板时点「收起」，缩成右下角**横向长条**（上行=回放标题，下行=进度条），不挡画面；点条展开，状态持久化。进度条**解析阶段为蓝色、下载阶段为绿色**，下载中也可收起随时盯进度。收起/展开用 `grid-template-rows:1fr→0fr` 做**高度平滑折叠**（内容与外壳走同一条 280ms `cubic-bezier(0.16,1,0.3,1)` 弹簧曲线，宽高透明度完全同步），并尊重系统「减少动态效果」设置。
- **下载光环**：下载进行时，面板最外层有一圈流动的渐变光带（蓝→青→粉，亮段沿边缘流动）。用 SVG 圆角矩形 + `stroke-dash` 实现，3s 慢速、不翻转；中间完全不涂色，**不会透进面板内部糊成色块**。收缩成横条时光环同样包住。 **v2.6.2 修复**：原先用 `pathLength=400` 把光带比例写死，实际周长被强行归一化，光带缩成一小段甚至不可见；现按真实周长动态计算 dasharray，动画偏移用 CSS 变量 `--ring-perim`，整周期正好走完一圈。光带跟随也补全了：进度条出现/宽度变化、折叠区展开收起等**不触发面板自身 transition** 的尺寸变化，现在也会同步光环。 **v3.0.2 修复**：原先同步逻辑挂在面板的 `transitionstart` / `transitionend` 上，而这两个事件会从子元素冒泡上来——收起面板时子元素先结束过渡（如「收起」按钮淡出 150ms，比面板 280ms 短），逐帧循环被提前停掉，面板还在收缩、光环却停在旧尺寸，于是「框出一大块地方」「展开后不跟着变大」。**v3.0.5 改为纯 CSS 跟随**：光环现在是面板的子元素，尺寸由 `width:100%`/`height:100%` 决定，浏览器自己保证与面板同大，不再用 JS 逐帧追几何（那种做法在原理上必然漏——面板尺寸变化有十几种来源，漏追一次就永久错位）。SVG 用 `pathLength=100` 归一化周长，光带比例固定为 28%，面板怎么变宽变窄都不用重算。
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

   脚本带 `@updateURL` / `@downloadURL`，**装过一次后可直接在油猴里「检查更新」自动升级**，或用面板底部的「检查更新」。

3. 在 Edge / Chrome 还需到 `edge://extensions/`（或 `chrome://extensions/`）→ 篡改猴 → 详细信息，打开 **「允许用户脚本」**。该开关默认关闭，关闭时脚本不会执行，右下角不会出现面板。

> 面板不出现时依次检查：该开关已开 → 油猴中脚本处于启用状态 → 回放页 `Ctrl+F5` 强制刷新 → F12 Console 查看报错。

---

## 使用

1. 打开回放页（`n.dingtalk.com/dingding/live-room/index.html?roomId=...&liveUuid=...`），右下角出现面板并自动读出链接。
2. 按需设置：**文件名**（留空用回放标题）、**输出格式**、**截取时长**（单位自动识别，留空为全部）、并发、重试。
3. 页面解析完成后会在后台预下载切片，日志会报完成进度。此时点「下载本页回放」只需合并保存，实际耗时取决于预下载完成度；状态栏依次显示：切片 `n/N` → 拼接 → 保存。
4. 选择 MP4 且下载成功后，面板内会出现**预览播放器**，可调倍速。TS 无法在浏览器内预览（见已知限制）。
5. 不用时可点「收起」把面板缩成右下角横条，点条即可展开；下载进行中光环保持可见。
6. 也可把任意回放链接粘贴进输入框再点下载，不必停留在该页。

也可以把 `.ts` 交给 ffmpeg 重封装：

```bash
ffmpeg -i in.ts -c copy -bsf:a aac_adtstoasc out.mp4
```

Windows 下中文文件名/引号易出问题，建议用 Python `subprocess.run([...])` 传参，或先改 ASCII 临时名。

---

## 原理

- `GET https://lv.dingtalk.com/csrf` —— 实测带上 `Origin` 头会返回 403 `Invalid CORS request`，不带则正常返回 token 与 `XSRF-TOKEN` cookie。
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

GitHub Actions 在每次 push / PR 上跑三项：`node --check` 语法检查、`test/run.js` 单元测试，以及 `test/version_guard.sh` —— 最后一项会在「改了 `.user.js` 却没 bump `@version`」时让 CI 失败（这个坑在 1.6.8 踩过一次：修复发布了，但版本号没涨，Tampermonkey 用户根本收不到更新）。

---

## 已知限制

- 截取默认按切片边界对齐（约 30 秒粒度）；开启「帧级精确截取」后对齐到关键帧，但需要完整切片集才能建立时间轴，且仅支持 TS（fMP4 会自动退回切片对齐）。
- 预览的**倍速只作用于面板内播放**，不改变已保存的文件——改写音频音量或播放速度需重新编码，浏览器内无法可靠完成；需要这类处理请把 `.ts` 交给 ffmpeg。
- `.ts` 无法在浏览器 `<video>` 内预览（Chromium 不解码 MPEG-TS），需 VLC / mpv / PotPlayer，或改选 MP4。
- 回放签名约 10 天有效，过期后重新点一次下载即可。
- 已授权 `@connect *`：HLS CDN 域名随回放变化（`dtliving-sz.dingtalk.com`、`dtlive-sz.dingtalk.com` 等），故放开为任意域名；介意可改成具体域名自行补充。
- 权限仅 `GM_xmlhttpRequest`（跨域请求）、`GM_download`（保存文件）、`GM_addStyle`（面板样式）、`GM_getValue`/`GM_setValue`（记住各项设置）、`GM_notification`（完成/失败通知）；脚本只读当前页 URL 的 query 参数，不读取、不上传任何页面内容。

---

## 版权提示

脚本通过钉钉的公开接口获取回放播放地址，该地址自带时效签名（约 10 天），脚本不破解也不篡改签名。钉钉《用户协议》对自动化访问与内容获取可能有专门条款，回放内容本身亦可能受版权保护。请仅下载**你有权留存**的内容，不要传播或用于商业用途。

---

## English version

<details>
<summary><b>Click to expand the English version</b> — click to collapse</summary>

A Tampermonkey userscript that downloads publicly accessible DingTalk live replays **without logging in** — it fetches the replay m3u8 playlist through public APIs, downloads every segment in the browser and assembles one file.

> Only download content **you have the right to keep**.

---

## Features (v3.0.6)

**Core**

- **No login required**: `csrf` → `getOpenLiveInfoV2` to obtain the signed playback URL, fully anonymous.
- **Output MP4 (default) / TS**: `.mp4` is remuxed in-browser by `mux.js`; `.ts` is a raw concatenation and has the widest compatibility.
- **Resolution picker**: multi-variant playlists are detected automatically (default `Auto` = highest bandwidth = original resolution). After prefetch the dropdown is filled in with every variant and its bitrate, and switching re-prefetches; the choice persists. **Single-variant TS streams get their original resolution analysed automatically** — a Range request pulls the first 64KB, the TS is demuxed and the H.264 SPS is parsed (Baseline / Main / High plus cropping parameters), so the first dropdown entry reads `Auto (original 1280×720)`. The history log also carries `H.264 Main @3.1`-style profile/level detail (verified against a real replay).
- **MP4 duration and progress bar fixed**: `mux.js` writes `0xFFFFFFFF` (the "unknown" sentinel) into `moov/mvhd/mdhd`, which makes players report a dozen-plus hours, refuse to seek, and freeze on one frame. The script walks `moof` boxes, recomputes the real duration from `tfdt + Σtrun`, and writes it back — a 30-minute replay then shows as 30 minutes and the file size is unchanged.
- **Failure diagnostics**: when a segment fails, the status line prints a one-line summary (index + cause + what to try), grouped by error type (401/403 signature expired, 404 replay already purged, anything else: lower concurrency or update the script).
- **Output history**: the status line shows only the newest entry by default; **click it** to expand the full history (up to 300 entries, scrollable) and click again to collapse. Full sentences wrap; nothing is clipped mid-character.
- **Progress animation**: progress bar plus status line, both fully rendered (wrapped, never truncated), showing the current stage and `n/N` live.

**Performance and prefetch**

- **Size estimate (v1.9.7)**: before downloading, a `Range: bytes=0-0` request fetches a single byte of the first segment to read `Content-Range`, giving the segment size; `segment size × count` yields the total without downloading anything extra. The parse stage logs `预计体积: 约 340 MB（单片 5.8 MB × 60 片）`; during download the progress bar adds `downloaded/estimated`. A failed probe is skipped silently and never blocks the download.
- **Integrity check (v1.9.7)**: after every segment is down, each one is validated — count complete, non-empty, and TS sync bytes aligned on the 188-byte period (the alignment point is searched within the first 188 bytes so legitimate segments carrying an ID3 or padding prefix still pass, while HTML error pages and truncated data are caught). On success the log reads `✅ 完整性校验通过：60/60 片 · 341.2 MB`; on failure **only the bad segments are nulled while the good ones stay as resume cache**, the offending indexes are listed, and pressing download refetches only those — never the whole replay again.
- **Frame-accurate clipping (v2.5.0 entry point; experimental, off by default)**: enabled in 更多设置. Slice-boundary alignment is only ever exact to a slice length (usually 30s); with this on, a second pass refines it by walking the video stream frame by frame, collecting every keyframe and snapping the start and end to the nearest IDR. **Because frame-level refinement needs the complete segment set to establish a timeline, enabling it downloads the full replay first and then trims** (more traffic and time, in exchange for precision slice alignment cannot reach). Streams cut mid-way are re-wrapped with fresh SPS/PPS inserted at the head of the output — otherwise players find no decoding parameters and the first frames fail to decode. fMP4 replays are unsupported (no TS packet structure); when too few keyframes are found it falls back to slice alignment, so chasing precision never costs you the file. **Since v2.5.0 the clip area carries a visible pointer**: anyone who does not know the feature can click the blue "open frame-accurate clipping here" link in the tip line, which expands 更多设置 and flashes the switch twice. The switch title states plainly that it is off by default and what turning it on costs.
- **Smart scheduling (v2.1.0)**: on by default in 更多设置. Two things at once — **greedy segment ordering**: a sample of segments from the head and tail is probed for real size (1-byte Range, nothing downloaded) and the largest ones go first, so the longest pole starts early and total completion time shrinks; **adaptive concurrency**: starts from your thread count, climbs toward 16 while segments keep succeeding, and the moment one fails it drops concurrency and backs off, then climbs again once things recover. When sizes cannot be probed (probe failed, or BYTERANGE segments) it falls back to the original order with no loss of function. The log reports the sample and the final concurrency. Turn it off and concurrency stays pinned at your setting, behaving exactly as in 1.9.x.
- **Background pre-download after parsing (v2.7.0)**: as soon as the segment list is parsed on opening a replay page, segments are fetched silently in the background (weak concurrency of 2 so bandwidth is not hogged) and the log reports `✓ 后台预下载完成 12 片 · 441 KB，现在点下载只需合并保存`. By the time you decide to download, pressing the button finishes almost instantly. Can be turned off in 更多设置 (on by default); switched off, behaviour is identical to 2.6.x. **The pre-download lives in memory only and is never written to disk** — a page reload discards it, so no undeletable ghost cache is ever created. 「中断」 and 「删除已下载」 clear it too.
- **Prefetch playback info**: the signed playback URL and segment index are fetched on page load so downloading can start without waiting.
- **Automatic thread count**: network-IO bound, so the default is CPU logical cores × 2 (clamped to 4–16); once you set it manually, your value wins.

**Download control**

- **Pause / resume**: freeze progress and continue later; already-downloaded segments are kept.
- **Interrupt**: stop this run; downloaded segments stay as resume cache and the next run continues from there.
- **Delete downloaded**: wipe every cached segment of this replay.
- **Failed-segment-only retry (v1.9.10)**: after a failure or an integrity check, a "retry failed segments only" button appears showing exactly how many failed and which (e.g. "2 failed last time (#3 #6)"). Clicking it refetches **only** those — everything already downloaded is reused via the IndexedDB resume cache (since v1.9.6), which survives reloads and closed tabs. Changing resolution or pressing 「删除已下载」 hides the button so stale numbers never mislead.
- **Live speed and ETA**: EMA speed plus estimated time remaining, shown next to the progress bar.
- **Completion / failure notifications (v1.9.9)**: optionally raise a system notification when a run ends — success or failure — carrying the filename and size (on failure, the cause and a suggested next step; clicking the notification returns to the panel). The sound is synthesised live with WebAudio (two rising tones on success, three falling on failure), no bundled audio file. Both switches live in 更多设置 and both are **off by default** — browser autoplay policies frequently block sound on pages without interaction, so having sound on by default just makes it look broken. The AudioContext is warmed up when you press download, which mitigates that policy. Turn them on if you want them.

**After the download**

- **Export an .m3u8 playlist (v1.9.12)**: 「📄 导出 m3u8」 at the panel bottom writes the segment list of the currently selected resolution as a standard playlist, ready for VLC / ffmpeg / any other downloader, or for archiving. Output is strict HLS: `TARGETDURATION` rounded up to the longest segment, `EXTINF` and segment URLs strictly alternating, `EXT-X-MAP` before the first `EXTINF`, `BYTERANGE` before its own segment URL, a `KEY` declaration (with IV) when AES-128 is in use, and `EXT-X-ENDLIST` at the end. Deliberately no BOM: some parsers would read the first line as a tag name. Verified with ffmpeg — duration and segment count match exactly.
- **One-click diagnostic log (v1.9.11)**: 「📋 导出诊断日志」 writes a `.txt` containing the script version, browser UA, hardware concurrency and the auto-detected thread count, parse results (segment count / duration / encryption / fMP4 / variant list), cache and pending-retry indexes, every setting, the outcome of each run, and **uncaught page exceptions and promise rejections**. Signatures inside playback URLs (`auth_key` / `token` / `sign` / `signature`, in any case variant) are stripped automatically — diagnostic text tends to get pasted straight into public issues, and leaving them in would leak one-time credentials.
- **Custom resolution (v1.9.11)**: besides the variants a playlist declares, the dropdown lists common tiers **not exceeding the original resolution** (4K / 1440p / 1080p / 900p / 720p / 540p / 480p / 360p / 270p); a trailing `自定义…` entry accepts `宽x高`, including the common hand-typed shapes `1920X1080`, `1920×1920`, full-width digits and a Chinese colon. Whatever you type is matched to the closest real variant — **and when no variant matches exactly it says which one it actually used**, so you are never left thinking you downloaded a resolution you did not ask for. With no usable variant it says so plainly and returns to `Auto`.
- **Download queue (v2.0.0)**: a multi-line queue under the link box (one replay per line) downloads them one after another via 「▶ 开始队列」. Line formats are lenient — a full URL, a bare query string, `roomId liveUuid`, or `roomId=liveUuid liveUuid=…` (the form you get copying from chat) all work; blank lines and `#` comments are ignored, and an unrecognised line is reported on its own with its line number. **One failing replay does not abort the queue** — queue five, let the third one's signature expire, and the remaining two still finish before a "succeeded N · failed M" summary. Sequential rather than concurrent on purpose: running several replays at once only makes them fight for bandwidth and all slow down; what users want is to queue a few, not to have them compete.
- **Choose the update source (v1.9.11)**: switch between **Gitee (default) / GitHub / Auto** in 更多设置. Gitee is the default because `raw.githubusercontent.com` is unreliable from mainland China while the Gitee mirror usually is not. Switching re-runs the check immediately and the "new version found" link follows the chosen source.
- **Link parsing fix (v1.9.8)**: pasting a bare query string without a domain (`?roomId=…&liveUuid=…`) no longer fails with "link is missing roomId/liveUuid" — the old fallback prepended another `?`, which glued an extra question mark onto the first parameter name so nothing resolved.
- **Custom filename**: type it in the panel; **left blank it uses the replay title** (the placeholder shows that title). An accidental `.mp4` / `.ts` suffix is stripped automatically. With "append timestamp" enabled the placeholder gains `_timestamp` and refreshes every second.

**Clipping and preview**

- **Clip range (unit auto-detected since v2.3.0)**: downloads only the segments between 开始 and 结束; leave blank for the whole replay. Aligned to slice boundaries (about 30s granularity). **The fields no longer prescribe a format** — once the total duration is parsed the panel tells you the cap: under an hour it offers `mm:ss`, at or above an hour it switches to `hh:mm:ss` (hours are not capped at 99, so `100:00:00` is valid), and the grey hint updates live. **Zero-padding on blur** (`1:2:3` → `01:02:03`), with full-width digits, Chinese colons, whitespace and zero-width characters auto-repaired as before. A two-part value (`1:30`) is never rewritten on a guess — it is inherently ambiguous between `mm:ss` and `hh:mm`, so it is parsed as `mm:ss` and out-of-range input reports a usable form. An end past the total duration is clamped to the end with a note.
- **Built-in preview**: after an MP4 finishes downloading, a player appears in the panel with **speed** (0.5×–2×) control. Playback speed affects the preview only, never the saved file — see Known limitations.
- **Filename timestamp**: append `_YYYYMMDD-HHmmss`.

**Panel appearance**

- **Enable frosted glass**: **off by default** (since v1.8.0). When on, both the panel and the collapsed bar become translucent with a background blur and a light border, letting the player show through; the state persists across reloads. In frosted mode the footer's small grey text automatically brightens and gains a text shadow so it stays readable over any content (v2.9.5 fix).
- **Draggable panel (v2.4.0, fixed in v2.6.0)**: press the title area (cursor turns into a grab hand) and drag the panel anywhere; the position is remembered across reloads. It drags while collapsed too (v2.6.0 fix — before that a collapsed panel could not be moved at all). **Dragging only starts from blank space** — pressing on an input, select or button leaves native behaviour untouched (v2.6.0 fix; before that the drag region wrapped the whole form and every field and dropdown was dead). **Horizontally** it is clamped inside the viewport so the panel cannot be lost; **vertically** it may leave the viewport, because the expanded panel is routinely taller than the window (600px+), and clamping it there would pin it to the top and read as "dragging is broken" — the page scrolls, so the panel scrolls with it. **v3.0.3 fix**: the horizontal clamp used to run only at drag time, and nothing recomputed it after a resize — drag the panel to the right edge and then shrink the window and most of it leaves the screen (measured: 240px of a 392px panel), the mouse can no longer reach it at all, and the only way back is reloading the page. The panel is now re-clamped against the last known position on every window resize, and repeated resizing does not accumulate drift.
- **Keyboard shortcuts (v2.4.0)**: `Space` starts the download and toggles pause/resume while running, `Esc` interrupts a running download and otherwise collapses or expands the panel, `M` toggles collapse. **None of them fire while you are typing** in an input or textarea, so typing an `m` never collapses the panel.
- **Auto-collapse settings while dragging (v2.6.0)**: collapsible sections and the preview area fold away while you drag and are restored when you release; a toggle in 更多设置 (on by default) turns this off.
- **Viewport-aware panel (v2.6.1)**: the panel's height is capped to the available window height (`100vh - 140px`) with the remainder scrolling inside. **Fully expanded, the panel never exceeds the screen** — measured at 678px in a 700px-tall window, which comfortably covers ordinary laptop viewports.
- **Compact 更多设置 (v2.6.0)**: number fields and dropdowns pair up on one row, and eight switches lay out in a two-column grid — roughly half the previous height, so options no longer need scrolling to find.
- **更多设置**: the collapsible area at the bottom, **collapsed by default**, holding low-frequency options — thread count, retries, **default panel state (expanded / collapsed)**, prefetch, frosted glass, **automatic update check (on by default)**. The first two and every switch persist via `GM_setValue`. The default-state dropdown reads back the real initial state from a single source of truth, so the value shown always matches the panel's actual state (v1.9.3 fixed a mismatch where the panel was collapsed but the dropdown said "expanded").
- **Collapse to a bar**: press 「收起」 when you do not need the panel and it shrinks to a slim horizontal bar at the bottom-right (title on top, progress bar below) without covering the video; click it to expand, and the state persists. The bar is **blue while parsing and green while downloading**, and collapsing mid-download is allowed so you can watch progress. The collapse is a smooth height animation (`grid-template-rows: 1fr → 0fr`) sharing one 280ms spring curve between content and shell, and it respects the OS "reduce motion" setting.
- **Download halo**: while a download runs, a gradient light band (blue → cyan → pink, with a bright segment flowing along the edge) wraps the panel's outermost edge. Built as an SVG rounded-rect with `stroke-dash` — 3s, slow, and it does not flip (rotating a non-square element looks jittery and fake). **The middle is not painted at all**, so it can never bleed into the panel and blur into a colour block, and it wraps the collapsed bar too. **v2.6.2 fix**: the band used to be sized with a hard-coded `pathLength=400` against the real perimeter, which squashed the dash pattern into a tiny stub or hid it entirely; the dash array is now computed from the actual perimeter and the animation offset uses a `--ring-perim` CSS variable so one cycle travels exactly one full loop. **v3.0.2 fix**: the follow logic was wired to the panel's `transitionstart` / `transitionend`, and both bubble up from child elements — collapsing the panel made a child finish first (the 「收起」 button fades in 150ms versus the panel's 280ms), which stopped the per-frame loop while the panel was still shrinking, leaving the halo frozen at its old size and framing a large empty area. **v3.0.5 makes it pure CSS**: the halo is now a child of the panel sized by `width:100%`/`height:100%`, so the browser itself guarantees it matches the panel — no more chasing geometry from JS, which could only ever track the cases it knew about. The SVG uses `pathLength=100` to normalise the perimeter, so the light band stays at a fixed 28% whatever the panel size.
- **No save dialog**: the browser writes the file straight to its default download directory (`saveAs:false`), so there is nothing to confirm and a dismissed dialog can no longer leave the script waiting forever.
- **Dark theme**: dark by design, with no light or system theme option.

**Protocol compatibility**

- **Multi-bitrate**: `#EXT-X-STREAM-INF` variants are detected and the highest bandwidth is chosen by default; a manual pick overrides it.
- **AES-128**: on `#EXT-X-KEY` the key is fetched via Web Crypto and each segment is decrypted on the fly.
- **fMP4 / BYTERANGE**: supports `#EXT-X-MAP` initialisation segments and `#EXT-X-BYTERANGE` byte ranges.
- **Concurrency** (1–16, auto-detected by default as CPU logical cores × 2, your setting wins once set) and **retries** (1–10, default 3, exponential backoff).

**Versions and updates**

- The panel footer shows the version beside a small grey "check for updates" label (no longer a button since v1.9.4). **The automatic check is on by default** (toggle in 更多设置): on page load it compares against the latest release in the background and, when a newer one exists, that label becomes a clickable blue "new version x.y.z ↑". **It never navigates on its own — click to open the update page.** With the automatic check off, pressing it checks manually and you still click once more to reach the download. "Already latest" and check failures appear briefly and then revert. **If GitHub is unreachable it falls back to the Gitee mirror.**
- Every release is tagged and recorded in [CHANGELOG.md](CHANGELOG.md).
- CI runs `node --check`, the unit tests, and a **version-bump guard** that fails the build if `.user.js` changed without `@version` increasing — the exact trap 1.6.8 fell into, where a fix shipped but users never received it.


---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open either Raw URL below to trigger the install page (GitHub or Gitee):

   ```
   https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   If GitHub is slow from mainland China, use the Gitee mirror:

   ```
   https://gitee.com/Vectg/dingtalk-live-replay-downloader/raw/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   The script ships `@updateURL` / `@downloadURL`, so **once installed it can upgrade itself through Tampermonkey's "check for updates"**, or via the panel's own update check.

3. On Edge / Chrome you must also open `edge://extensions/` (or `chrome://extensions/`) → Tampermonkey → Details and turn on **"Allow user scripts"**. It is off by default; while off the script does not run and no panel appears.

> If the panel is missing: confirm the toggle is on → the script is enabled in Tampermonkey → hard-reload the replay page with `Ctrl+F5` → check the F12 console for errors.

---

## Usage

1. Open the replay page (`n.dingtalk.com/dingding/live-room/index.html?roomId=...&liveUuid=...`); the panel appears at the bottom-right and reads the link automatically.
2. Optionally set **filename** (blank uses the replay title), **output format**, **clip range** (units auto-detected, blank means everything), concurrency and retries.
3. Once the page has parsed, segments are pre-downloaded in the background and the log reports progress. Pressing "下载本页回放" then only has to merge and save; how long that takes depends on how much the pre-download already finished. The status line shows segments `n/N` → merge → save.
4. With MP4 selected and the download successful, a preview player appears in the panel with **speed** control. TS cannot be previewed in a browser (see Known limitations).
5. When you do not need it, press 「收起」 to shrink the panel to a slim bar at the bottom-right; click it to expand. The halo stays visible while downloading.
6. You can also paste any replay link into the box and press download without staying on that page.

To remux a `.ts` with ffmpeg:

```bash
ffmpeg -i in.ts -c copy -bsf:a aac_adtstoasc out.mp4
```

On Windows, non-ASCII filenames and quotes are easy to get wrong; prefer Python `subprocess.run([...])` or rename to ASCII first.

---

## How it works

- `GET https://lv.dingtalk.com/csrf` — in practice, sending an `Origin` header makes it return 403 `Invalid CORS request`; without it the token and `XSRF-TOKEN` cookie come back normally.
- `POST https://lv.dingtalk.com/getOpenLiveInfoV2` — the body is a **single object** `{roomId, liveUuid}`, and it must carry both the `XSRF-TOKEN` cookie and the `X-XSRF-TOKEN` header (same token) → returns `openLiveDetailModel.playbackUrl`, a signed m3u8 valid for about 10 days.
- The m3u8 is parsed into individually signed segment URLs, downloaded concurrently and concatenated in order.
- `getOpenLiveInfo` (V1) returns an **empty** `playbackUrl` for anonymous callers, so V2 is mandatory. `sliceCount` / `sliceDuration` are sprite-sheet parameters, **not** segment counts — trust the actual m3u8 entries.
- **MP4 duration repair**: `mux.js` targets MSE streaming and leaves `mvhd/tkhd/mdhd` duration as `0xFFFFFFFF`. The script walks `moof/traf`, recomputes each track's real end time from `tfdt + Σtrun.sample_duration`, converts by timescale and writes it back. Media data and file size are unchanged.

---

## Development

```bash
git clone https://github.com/Vectg/dingtalk-live-replay-downloader.git
cd dingtalk-live-replay-downloader
node test/run.js
```

Tests do not run against a copy: `test/extract.js` slices functions straight out of the **published `钉钉直播回放下载.user.js`** and executes them, so what is tested is exactly what users install. Extraction balances braces while skipping strings, regexes and comments, and `test/run.js` self-checks that the extracted source compiles.

GitHub Actions runs three jobs on every push / PR: `node --check`, the unit tests, and `test/version_guard.sh` — the last one fails the build if `.user.js` changed without `@version` increasing, the exact trap 1.6.8 fell into where a fix shipped but users never received it.

---

## Known limitations

- Clipping is aligned to slice boundaries by default (about 30s granularity). With 「帧级精确截取」 enabled it snaps to keyframes, but that needs the complete segment set to build a timeline, and it works for TS only (fMP4 falls back to slice alignment).
- Preview **speed affects the in-panel playback only**, never the saved file — rewriting audio volume or playback speed requires re-encoding, which cannot be done reliably in the browser. Hand the `.ts` to ffmpeg for that.
- `.ts` cannot be previewed in a browser `<video>` (Chromium does not decode MPEG-TS); use VLC / mpv / PotPlayer, or pick MP4 instead.
- Replay signatures last about 10 days; press download once more after they expire.
- `@connect *` is granted because HLS CDN hosts vary per replay (`dtliving-sz.dingtalk.com`, `dtlive-sz.dingtalk.com`, …). Replace it with explicit hosts if you prefer.
- Permissions are limited to `GM_xmlhttpRequest` (cross-origin requests), `GM_download` (saving files), `GM_addStyle` (panel styles), `GM_getValue` / `GM_setValue` (remembering settings) and `GM_notification` (completion / failure notices). The script only reads the current page URL's query parameters; it neither reads nor uploads page content.

---

## Copyright

The script obtains replay playback URLs through DingTalk's public interfaces. Those URLs carry a time-limited signature (about 10 days) which the script neither cracks nor modifies. DingTalk's Terms of Service may have specific provisions on automated access, and replay content may itself be copyrighted. Download only content **you have the right to keep**; do not redistribute or use it commercially.

---

</details>

---

## License / 许可

[MIT](LICENSE)
