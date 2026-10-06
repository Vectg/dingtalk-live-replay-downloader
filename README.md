# dingtalk-live-replay-downloader

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-blue)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Changelog](https://img.shields.io/badge/CHANGELOG-3.6.3-informational)](CHANGELOG.md)

通过公开接口获取钉钉直播**回放**的 m3u8 播放列表，浏览器内下载全部切片并拼成一个文件. **无需登录钉钉账号**即可下载公开可访问的回放，在回放页点一下即可.

> 仅用于下载你有权留存的内容.

**中文（默认）** ｜ [English](#english-version)

---

## 功能（v3.6.3）

> 每个功能的修复史与实测数据都在 [CHANGELOG.md](CHANGELOG.md)，这里只讲当前行为.

**核心**

- **无需登录**：`csrf` → `getOpenLiveInfoV2` 取带签名的播放地址，全程匿名.
- **输出 MP4（默认）/ TS**：`.mp4` 由 `mux.js` 在浏览器内转封装；`.ts` 为原始拼接，兼容性最好.
- **分辨率选择**：多档播放列表自动识别（默认「自动」= 最高带宽 = 原始分辨率），预取后回填各档位与码率，切换即重新预取. 单档 TS 会自动分析原始分辨率（Range 拉首片 64KB → 解析 H.264 SPS），下拉第一项直接显示 `自动（原始分辨率 1280×720）`.
- **MP4 时长已修复**：`mux.js` 输出的 duration 是 `0xFFFFFFFF`（unknown 哨兵），播放器会显示成十几小时、拖不动进度条、画面卡死. 脚本遍历 `moof` 用 `tfdt + Σtrun` 算出真实时长写回，媒体数据与文件大小都不变.
- **下载队列（v2.0.0）**：链接框下方可填多行队列（每行一个回放），按顺序依次下载完. 行格式宽松——整段链接、裸查询串、`roomId liveUuid`、从聊天记录复制的 `roomId=liveUuid liveUuid=…` 都能识别；空行与 `#` 注释忽略，无法识别的行会指出是第几行. **单个回放失败不会中断整队**，最后汇总「成功 N · 失败 M」. 刻意顺序执行而非并发：并发只会让它们互抢带宽、一起变慢.
- **完整性校验（v1.9.7）**：全部切片下完逐片校验——数量齐全、非空、TS 同步字节 188 周期对齐（在首 188 字节内找对齐点，兼容带 ID3/填充前缀的合法切片；HTML 错误页与截断数据会被识破）. 通过则报 `✅ 完整性校验通过：60/60 片 · 341.2 MB`；发现异常**只把问题片置空、好片保留为断点缓存**，点下载只补异常片.
- **只重试失败切片（v1.9.10）**：失败后出现「♻ 只重试失败切片」按钮，写明上次失败了几片、具体片号. 断点缓存存 IndexedDB（v1.9.6 起），跨刷新、关页后依然有效.

**下载**

- **暂停/继续**：下载中同一键随状态切换，暂停后进度完全冻结.
- **中断**：已下载切片保留为断点缓存，再点下载自动续传（日志 `♻ 命中断点缓存`），不会重下.
- **删除已下载**：清空全部切片缓存（含 IndexedDB），下次从头开始.
- **体积预估（v1.9.7）**：下载前用 `Range: bytes=0-0` 只拉首片 1 字节读 `Content-Range`，`单片 × 片数` 得出总量，不额外下载整片. 探测失败静默跳过，不影响下载.
- **实时速度与预计剩余时间**：进度条显示 `切片 6/12 · 1.2 MB/s · 剩 00:01`（EMA 平滑）.
- **帧级精确截取（v2.5.0，默认关）**：切片对齐只能精确到切片长度（通常 30 秒），开启后逐帧找关键帧把起止点对齐到离目标最近的 IDR. **需要完整切片集才能建立时间轴，所以启用时会先下载完整回放再裁剪**. fMP4 不支持；关键帧不足时自动退回切片对齐，绝不会因为「想更精确」而让用户拿不到文件. 截取区有蓝色指引链接，点一下自动展开「更多设置」并让开关闪两下.
- **智能调度（v2.1.0，默认开）**：抽样探测头尾各若干片的真实体积（1 字节 Range），体积大的先下，让最长的那根线尽早启动；并发从你设定的线程数起步，连续成功就逐级加到 16，一旦有切片失败立刻降并发退避，恢复后再爬回去. 体积探不到时自动退回原序.
- **解析后后台预下载（v2.7.0，默认开）**：解析出切片列表的那一刻就在后台弱并发（2，不抢带宽）静默下载，等你点下载时几乎瞬间完成. **只存内存不落盘**，刷新即丢弃，不会产生「删不掉」的幽灵缓存.
- **完成/失败通知（v1.9.9，默认关）**：结束时可选弹系统通知，标题点明成败、正文带文件名与体积. 提示音用 WebAudio 现场合成（完成两声上行、失败三声下行），不带外部音频文件. 默认关闭是因为浏览器自动播放策略常拦未交互页面的声音，声音默认开容易让人以为坏了.

**下载后处理**

- **自定义文件名**：留空则自动使用回放标题（placeholder 即标题），误带的 `.mp4`/`.ts` 后缀自动去掉. 勾选「文件名加时间戳」后 placeholder 追加 `_时间戳` 且每秒刷新.
- **截取时长**：只下载「开始 → 结束」区间内的切片，留空即整段；按切片边界对齐（约 30 秒粒度）. **时间框不预设格式**——解析出总时长后自动告诉你上限：不足 1 小时给 `mm:ss`，达到 1 小时及以上换成 `hh:mm:ss`（小时位不限 99，可填 `100:00:00`）. **失焦自动补零**（`1:2:3` → `01:02:03`），全角数字/中文冒号/空白/零宽字符照旧自动修复. 两段写法（如 `1:30`）天然歧义，一律按 `mm:ss` 解析. 结束超出总时长自动截到末尾并提示.
- **统一导出（v3.6.0）**：诊断日志 / m3u8 / 聊天记录合并为面板底部**一个下拉 + 一个「⬇ 导出」按钮**，选择会记入本地存储. 三种内容：
  - **📋 诊断日志 `.txt`** —— 脚本版本、浏览器 UA、硬件并发与自动识别的线程数、解析结果（切片数/时长/加密/fMP4/多码率档位）、缓存与待重试片号、各项设置、每次下载的成败结论，以及**页面未捕获的异常与 Promise 拒绝**. 播放地址里的签名（`auth_key`/`token`/`sign`/`signature`，含大小写变体）会自动抹除——诊断文本常被直接贴到公开 issue 里，不抹除等于泄露一次性凭证.
  - **📄 m3u8 播放列表** —— 把当前分辨率的切片列表存成标准播放列表，便于用 VLC / ffmpeg / 其他下载器重新拉取或存档. 严格按 HLS 规范输出：`TARGETDURATION` 向上取整到最长片、`EXTINF` 与切片 URL 严格交替、`EXT-X-MAP` 在首个 `EXTINF` 之前、`BYTERANGE` 在其切片 URL 之前、AES-128 时带 `KEY` 声明（含 IV）、结尾 `EXT-X-ENDLIST`. 刻意不加 BOM：部分解析器会把带 BOM 的首行当成标签名.
  - **💬 聊天记录** —— 拉取回放聊天的全部评论历史（最多 20 页游标）. `.txt`（逐条 `[时间] 用户: 内容`）、`.json`（带导出时间戳与元信息）、`.csv`（BOM 防乱码）、`.html`（可直接双击查看/打印）. 接口 `https://lv.dingtalk.com/live/listComment`，GET 带 `loadMoreId` 游标分页，`sortType` 必填.
- **自定义分辨率（v1.9.11）**：下拉除播放列表声明的档位外，还列出**不超过原始分辨率**的常用档位（4K/1440p/1080p/900p/720p/540p/480p/360p/270p）；末尾「自定义…」可手填 `宽x高`，支持 `1920X1080`、`1920×1080`、全角数字与中文冒号等常见手打写法. 填的值会匹配到最接近的真实档位——**匹配不到正好这一档时明确告知实际用了哪一档**，不会让你以为下了自己没填的分辨率.

**面板**

- **面板内嵌侧栏（v3.2.0，默认关）**：更多设置里打开后，整个面板在**页面加载时**立刻内嵌到右侧「互动/简介」页签下方（不是等解析完才嵌，侧栏晚上线会自动重试）. 面板与页签、内容区同为流内兄弟：页签固定在上、永不被遮挡，内容区按 flex 自行让位且照常滚动. 内嵌态自动切紧凑排版（可见比例 25% → 54%），顶边抓手可上下拖动调高度（默认 430px）. 内嵌态禁用拖拽与窗口重定位，几何全交给 CSS. React 切页签把面板甩掉时 1.5s 内自动挂回；侧栏消失（窄窗口/退出登录）则自动回到悬浮、回来再挂上.
- **内嵌滚动与底栏（v3.2.1）**：内嵌时内容超出可见高度**可直接滚轮下滑**；**版本号 / 检查更新那一栏永远钉在面板最底部**，不需要滚到底才看得见（收起时自动隐藏，不留空条）. 两项在内嵌与悬浮两种形态下都生效.
- **悬浮态滚动条（v3.6.2）**：面板拖到视口下半部分再全部展开时，可滚高度只剩一百多像素，正文会冒出一根滚动条（内层还叠着第二根）. 现在按面板实际位置实时算出还能往下长多少，展开动画途中就生效；内嵌到侧栏时自动交还给侧栏自己的高度.
- **面板可拖拽（v2.4.0）**：按住面板标题区（光标变抓手）即可拖到任意位置，位置自动记住，**收起成横条后同样能拖**. **只有按在空白处才触发拖拽**——落在输入框、下拉框、按钮上时浏览器原生行为照旧. **横向**夹在可视区内防止面板拖丢；**纵向**允许拖出视口——面板展开后往往比窗口还高（600px+），强行夹住会永远贴死在顶部、看着像「拖不动」. 窗口缩放时按上次坐标重新钳制，不会累积漂移.
- **收缩为横条**：不看面板时点「收起」，缩成右下角**横向长条**（上行=回放标题，下行=进度条），不挡画面；点条展开，状态持久化. 进度条**解析阶段为蓝色、下载阶段为绿色**，下载中也可收起随时盯进度. 收起/展开用 `grid-template-rows:1fr→0fr` 做**高度平滑折叠**（内容与外壳走同一条 280ms 弹簧曲线），并尊重系统「减少动态效果」设置.
- **下载光环**：下载进行时面板最外层有一圈流动的渐变光带（蓝→青→粉，亮段沿边缘流动），收缩成横条时同样包住. 现为**首尾透明的线性渐变 + 旋转整个渐变坐标系**——没有任何长度概念，面板无论多大、什么比例，光带宽度与流速都恒定. 中间完全不涂色，**不会透进面板内部糊成色块**. 光环是面板的子元素、尺寸由 `width:100%`/`height:100%` 决定，浏览器自己保证与面板同大，不用 JS 逐帧追几何.
- **开启毛玻璃效果**：默认**关闭**（v1.8.0 起）. 开启后面板与**收起的横条**均为半透明 + 背景模糊（`backdrop-filter`），可透出底层播放器画面. 毛玻璃态下页脚小字自动**提亮 + 文字阴影**，底层画面再亮也读得清.
- **键盘快捷键（v2.4.0）**：`空格` 开始下载 / 下载中暂停继续（同一键随状态切换）、`Esc` 下载中立刻中断、空闲时收起或展开面板、`M` 切换收起. **在输入框里打字时一律不拦截**，不会因为想输个 `m` 就把面板收起.
- **更多设置**：面板底部的可折叠区，**默认收起**，收纳低频选项——并发线程、重试次数、**面板状态（默认展开/收缩）**、预取播放信息、毛玻璃、**自动检查更新（默认开启）**. 前两项的取值与所有开关状态均持久化（`GM_setValue`），刷新后保留. 展开/收起箭头为 CSS chevron（90° 平滑翻转），带 260ms 弹簧缓出过渡.
- **拖动时自动收起设置（v2.6.0，默认开）**：拖动面板时自动折叠「更多设置」，拖完自动恢复原状态——折叠区在拖动过程中只会碍事.
- **不再弹保存对话框**：点下载后直接交给浏览器存到默认下载文件夹（`saveAs:false`）. 旧版弹的系统对话框在油猴里点「取消」不会回传任何回调，无法可靠判断，会造成「点取消却仍在下载」.
- **深色主题**：面板、输入框、按钮均为深色，暗光环境下不刺眼.

**性能**

- **预取播放信息**（默认开）：打开回放页即在后台预取 csrf → 播放地址 → m3u8 切片索引，缓存 10 分钟. 点「下载本页回放」直接进入切片下载阶段. 文件名 placeholder 会直接回填为解析出的回放标题.
- **并发线程自动识别**：默认按 CPU 逻辑核数 ×2 推算（4~16 封顶），网络 IO 密集场景下比固定 5 线程更快；「更多设置」里的说明文字会直接显示本次识别到的线程数. 手动改过之后以你的设置为准（`GM_setValue`），刷新后保留.

**发送到下载器（实验性）**

- **下载交给 aria2（v3.4.0，默认关）**：更多设置里的**总开关**. 打开后**所有下载任务**都改由本机 aria2 执行——点「下载本页回放」以及队列里的每一个回放，面板只负责解析出切片清单并逐条 `addUri` 推送，浏览器内的切片下载 / 拼接 / 保存全部跳过；关闭时行为与之前完全一致. 开关状态持久化.
- **aria2 配置（v3.3.0）**：更多设置里的 aria2 区块有主机 / 端口 / 密钥 / 保存目录 + 「🔌 测试连接」，设置持久化（密钥只写本地存储）. **aria2 不支持 m3u8**，所以是逐条推送而不是丢一个播放列表地址，用 `system.multicall` 每批 40 条一次 POST. 产物是 `seg00000.ts …` 这样的切片文件，日志会给出 `ffmpeg -f concat` 合成命令.
- **诚实拒绝而不是假装能推**：AES-128 加密切片（密钥只在浏览器里解密）与 fMP4（含独立初始化段）会直接拒绝并在状态栏说明原因.
- **错误分类**：`Unauthorized` 提示核对 `--rpc-secret`；`Invalid Request` / `No such method` 提示 aria2 版本过旧；连不上则提示确认已启动与端口. 测试连接用 `aria2.getVersion` 区分这几种情况.
- **安全基线**：只连 `127.0.0.1` + 密钥. **不要**只开 `--rpc-allow-origin-all`（源码上它不校验 Origin/Host，任何网页都能借它往你磁盘写文件）.

**版本与更新**

- 面板底部版本号旁是灰色小字「检查更新」（v1.9.4 起不再是按钮）：**自动检查默认开启**（更多设置可关），打开页面后在后台比对 GitHub 最新版本，发现新版时该处变为蓝色可点的「发现新版 x.y.z ↑」——**不会自动跳转，点击才打开更新页**. 关闭自动检查后点它手动比对，看到「发现新版」再点一次才跳转. **GitHub 不通时自动回落到 Gitee 镜像**.
- **自选更新源（v1.9.11）**：更多设置里可切换 **Gitee（默认）/ GitHub / 自动**. 默认 Gitee——`raw.githubusercontent.com` 在国内时通时不通，Gitee 镜像通常稳定. 切换后立即按新源重新检查一次.
- 每个版本都有 git tag 与 [CHANGELOG.md](CHANGELOG.md) 条目.

**协议兼容**

- **多码率**：遇 `#EXT-X-STREAM-INF` 自动选最高带宽递归.
- **AES-128**：遇 `#EXT-X-KEY` 用 Web Crypto 拉 key 逐片解密.
- **fMP4 / BYTERANGE**：支持 `#EXT-X-MAP` 初始化段与 `#EXT-X-BYTERANGE` 字节范围.
- **并发**（1–16，默认自动识别 = CPU 逻辑核数 ×2，手动设置后以设置为准）与**重试**（1–10，默认 3，指数退避）.

**其他**

- **链接解析修复（v1.9.8）**：粘贴不带域名的裸查询串（`?roomId=…&liveUuid=…`）不再报「链接缺少 roomId/liveUuid」——旧代码在回退拼接时会把开头的 `?` 再拼一个，导致参数名带上多余问号而取不到.
- **队列失败原因重复前缀（v3.6.3）**：下载队列里某一项失败时，汇总原因曾带两层「❌ 失败:」——状态栏写的是半角冒号，而剥前缀的正则只认全角冒号，两者对不上. 现已半角/全角都认.
- **文案标点（v3.6.3）**：脚本与本文档统一使用英文句号，中文正文里的逗号/顿号/冒号/括号保持不变.

---

## 安装

1. 安装 [Tampermonkey（油猴）](https://www.tampermonkey.net/).
2. 打开下面的 Raw 地址即可触发安装页（GitHub 与 Gitee 二选一）：

   ```
   https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   国内访问慢可改用 Gitee 镜像：

   ```
   https://gitee.com/Vectg/dingtalk-live-replay-downloader/raw/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   脚本带 `@updateURL` / `@downloadURL`，**装过一次后可直接在油猴里「检查更新」自动升级**，或用面板底部的「检查更新」.

3. 在 Edge / Chrome 还需到 `edge://extensions/`（或 `chrome://extensions/`）→ 篡改猴 → 详细信息，打开 **「允许用户脚本」**. 该开关默认关闭，关闭时脚本不会执行，右下角不会出现面板.

> 面板不出现时依次检查：该开关已开 → 油猴中脚本处于启用状态 → 回放页 `Ctrl+F5` 强制刷新 → F12 Console 查看报错.

---

## 使用

1. 打开回放页（`n.dingtalk.com/dingding/live-room/index.html?roomId=...&liveUuid=...`），右下角出现面板并自动读出链接.
2. 按需设置：**文件名**（留空用回放标题）、**输出格式**、**截取时长**（单位自动识别，留空为全部），并发与重试在「更多设置」里.
3. 页面解析完成后会在后台预下载切片，日志会报完成进度. 此时点「下载本页回放」只需合并保存，实际耗时取决于预下载完成度；状态栏依次显示：切片 `n/N` → 拼接 → 保存.
4. 下载完成后状态栏显示 `✅ 完成`，文件已存入浏览器默认下载文件夹；v3.2.0 起不再在面板内弹出预览播放器与倍速播放.
5. 不用时可点「收起」把面板缩成右下角横条，点条即可展开；下载进行中光环保持可见.
6. 也可把任意回放链接粘贴进输入框再点下载，不必停留在该页.

也可以把 `.ts` 交给 ffmpeg 重封装：

```bash
ffmpeg -i in.ts -c copy -bsf:a aac_adtstoasc out.mp4
```

Windows 下中文文件名/引号易出问题，建议用 Python `subprocess.run([...])` 传参，或先改 ASCII 临时名.

---

## 原理

- `GET https://lv.dingtalk.com/csrf` —— 实测带上 `Origin` 头会返回 403 `Invalid CORS request`，不带则正常返回 token 与 `XSRF-TOKEN` cookie.
- `POST https://lv.dingtalk.com/getOpenLiveInfoV2` —— body 是**单个对象** `{roomId, liveUuid}`，且必须同时带 `XSRF-TOKEN` cookie 与 `X-XSRF-TOKEN` 头（同一 token）→ 返回 `openLiveDetailModel.playbackUrl`（带签名的 m3u8，约 10 天有效）.
- 解析 m3u8 得到带各自签名的切片 URL，并发下载后按顺序字节拼接.
- `getOpenLiveInfo`（V1）对匿名用户 `playbackUrl` 是**空字符串**，必须用 V2；`sliceCount`/`sliceDuration` 是雪碧图参数、**不是**切片数，以 m3u8 实际条目为准.
- **MP4 duration 修补**：`mux.js` 面向 MSE 流式播放，`moov` 里 `mvhd/tkhd/mdhd` 的 duration 留为 `0xFFFFFFFF`. 脚本遍历 `moof/traf`，用 `tfdt + Σtrun.sample_duration` 算出每轨真实结束时间，换算 timescale 后写回；媒体数据本身不变、文件大小不变.

---

## 开发

```bash
git clone https://github.com/Vectg/dingtalk-live-replay-downloader.git
cd dingtalk-live-replay-downloader
node test/run.js
```

测试不从副本跑：`test/extract.js` 直接从**已发布的 `钉钉直播回放下载.user.js`** 里按函数名抽取源码执行，所以测的就是用户真正装到 Tampermonkey 里的那份代码，不会出现「测试通过但发布出去是另一份实现」. 抽取按花括号配平并跳过字符串/正则/注释，`test/run.js` 开头还会自检抽取结果是否完整可编译.

GitHub Actions 在每次 push / PR 上跑三项：`node --check` 语法检查、`test/run.js` 单元测试，以及 `test/version_guard.sh` —— 最后一项会在「改了 `.user.js` 却没 bump `@version`」时让 CI 失败（这个坑在 1.6.8 踩过一次：修复发布了，但版本号没涨，Tampermonkey 用户根本收不到更新）.

---

## 已知限制

- 截取默认按切片边界对齐（约 30 秒粒度）；开启「帧级精确截取」后对齐到关键帧，但需要完整切片集才能建立时间轴，且仅支持 TS（fMP4 会自动退回切片对齐）.
- **下载光环的动画在高分辨率屏幕上可能不够顺滑**（4K / 高 DPI 环境反馈）. 光环本身的位置与尺寸已正确贴合面板；卡顿只影响动画流畅度，不影响下载. 已排除「dash 动画计算量过大」这一常见猜测——实测关闭动画与开启动画的帧耗时一致. 待查方向与验证方法见 CHANGELOG 的「未发布」小节.
- 回放签名约 10 天有效，过期后重新点一次下载即可.
- 已授权 `@connect *`：HLS CDN 域名随回放变化（`dtliving-sz.dingtalk.com`、`dtlive-sz.dingtalk.com` 等），故放开为任意域名；介意可改成具体域名自行补充.
- 权限仅 `GM_xmlhttpRequest`（跨域请求）、`GM_download`（保存文件）、`GM_addStyle`（面板样式）、`GM_getValue`/`GM_setValue`（记住各项设置）、`GM_notification`（完成/失败通知）；脚本只读当前页 URL 的 query 参数，不读取、不上传任何页面内容.

---

## 版权提示

脚本通过钉钉的公开接口获取回放播放地址，该地址自带时效签名（约 10 天），脚本不破解也不篡改签名. 钉钉《用户协议》对自动化访问与内容获取可能有专门条款，回放内容本身亦可能受版权保护. 请仅下载**你有权留存**的内容，不要传播或用于商业用途.

---

## English version

<details>
<summary><b>Click to expand the English version</b> — click to collapse</summary>

A Tampermonkey userscript that downloads publicly accessible DingTalk live replays **without logging in** — it fetches the replay m3u8 playlist through public APIs, downloads every segment in the browser and assembles one file.

> Only download content **you have the right to keep**.

---

## Features (v3.6.3)

> Per-feature fix history and measurements live in [CHANGELOG.md](CHANGELOG.md); only current behaviour is listed here.

**Core**

- **No login required**: `csrf` → `getOpenLiveInfoV2` to obtain the signed playback URL, fully anonymous.
- **Output MP4 (default) / TS**: `.mp4` is remuxed in-browser by `mux.js`; `.ts` is a raw concatenation and has the widest compatibility.
- **Resolution picker**: multi-variant playlists are detected automatically (default `Auto` = highest bandwidth = original resolution), and after prefetch the dropdown is filled in with every variant and its bitrate — switching re-prefetches, and the choice persists. **Single-variant TS streams get their original resolution analysed automatically** (a Range request pulls the first 64KB, the TS is demuxed and the H.264 SPS parsed, including cropping parameters), so the first entry reads `Auto (original 1280×720)`.
- **MP4 duration and progress bar fixed**: `mux.js` writes `0xFFFFFFFF` (the "unknown" sentinel) into `moov/mvhd/mdhd`, which makes players report a dozen-plus hours, refuse to seek and freeze on one frame. The script walks `moof` boxes, recomputes the real duration from `tfdt + Σtrun`, and writes it back — media data and file size are unchanged.
- **Download queue (v2.0.0)**: a multi-line queue under the link box (one replay per line) downloads them one after another. Line formats are lenient — a full URL, a bare query string, `roomId liveUuid`, or `roomId=liveUuid liveUuid=…` (the form you get copying from chat) all work; blank lines and `#` comments are ignored, and an unrecognised line is reported with its line number. **One failing replay does not abort the queue** — the remaining ones still finish before a "succeeded N · failed M" summary. Sequential rather than concurrent on purpose: running several at once only makes them fight for bandwidth and all slow down; what users want is to queue a few, not to have them compete.
- **Integrity check (v1.9.7)**: after every segment is down, each one is validated — count complete, non-empty, and TS sync bytes aligned on the 188-byte period (the alignment point is searched within the first 188 bytes so legitimate segments carrying an ID3 or padding prefix still pass, while HTML error pages and truncated data are caught). On success the log reads `✅ 完整性校验通过：60/60 片 · 341.2 MB`; on failure **only the bad segments are nulled while the good ones stay as resume cache**, the offending indexes are listed, and pressing download refetches only those.
- **Failed-segment-only retry (v1.9.10)**: after a failure or an integrity check, a 「♻ 只重试失败切片」 button appears showing exactly how many failed and which. Clicking it refetches **only** those — everything already downloaded is reused via the IndexedDB resume cache (since v1.9.6), which survives reloads and closed tabs. Changing resolution or pressing 「删除已下载」 hides the button so stale numbers never mislead.

**Downloading**

- **Pause / resume**: one key toggles by state; progress freezes completely while paused.
- **Interrupt**: downloaded segments stay as resume cache and the next run continues from there (`♻ 命中断点缓存`) — nothing is refetched.
- **Delete downloaded**: wipe every cached segment (IndexedDB included) and start over next time.
- **Size estimate (v1.9.7)**: before downloading, a `Range: bytes=0-0` request fetches a single byte of the first segment to read `Content-Range`; `segment size × count` yields the total without downloading anything extra. A failed probe is skipped silently and never blocks the download.
- **Live speed and ETA**: the progress bar shows `切片 6/12 · 1.2 MB/s · 剩 00:01` (EMA smoothed).
- **Frame-accurate clipping (v2.5.0, off by default)**: slice-boundary alignment is only ever exact to a slice length (usually 30s); with this on, a second pass walks the video stream frame by frame, collects every keyframe and snaps the start and end to the nearest IDR. **Because frame-level refinement needs the complete segment set to establish a timeline, enabling it downloads the full replay first and then trims** (more traffic and time, in exchange for precision slice alignment cannot reach). fMP4 replays are unsupported (no TS packet structure); when too few keyframes are found it falls back to slice alignment, so chasing precision never costs you the file. The clip area carries a visible pointer: clicking the blue link expands 更多设置 and flashes the switch twice.
- **Smart scheduling (v2.1.0, on by default)**: a sample of segments from the head and tail is probed for real size (1-byte Range, nothing downloaded) and the largest ones go first, so the longest pole starts early and total completion time shrinks; **adaptive concurrency** starts from your thread count, climbs toward 16 while segments keep succeeding, and the moment one fails it drops concurrency and backs off, then climbs again once things recover. When sizes cannot be probed (probe failed, or BYTERANGE segments) it falls back to the original order with no loss of function.
- **Background pre-download after parsing (v2.7.0, on by default)**: as soon as the segment list is parsed, segments are fetched silently in the background (weak concurrency of 2 so bandwidth is not hogged) and pressing the button later finishes almost instantly. **The pre-download lives in memory only and is never written to disk** — a reload discards it, so no undeletable ghost cache is ever created. 「中断」 and 「删除已下载」 clear it too.
- **Completion / failure notifications (v1.9.9, off by default)**: optionally raise a system notification when a run ends, its title stating success or failure and its body carrying the filename and size. The sound is synthesised live with WebAudio (two rising tones on success, three falling on failure), no bundled audio file. Both switches are **off by default** because browser autoplay policies frequently block sound on pages without interaction, so having sound on by default just makes it look broken.

**After the download**

- **Custom filename**: type it in the panel; **left blank it uses the replay title** (the placeholder shows that title). An accidental `.mp4` / `.ts` suffix is stripped automatically. With "append timestamp" enabled the placeholder gains `_timestamp` and refreshes every second.
- **Clip range**: downloads only the segments between 开始 and 结束; leave blank for the whole replay. Aligned to slice boundaries (about 30s granularity). **The fields no longer prescribe a format** — once the total duration is parsed the panel tells you the cap: under an hour it offers `mm:ss`, at or above an hour it switches to `hh:mm:ss` (hours are not capped at 99, so `100:00:00` is valid), and the grey hint updates live. **Zero-padding on blur** (`1:2:3` → `01:02:03`), with full-width digits, Chinese colons, whitespace and zero-width characters auto-repaired. A two-part value (`1:30`) is inherently ambiguous between `mm:ss` and `hh:mm`, so it is parsed as `mm:ss` rather than rewritten on a guess. An end past the total duration is clamped to the end with a note.
- **Unified export (v3.6.0)**: the diagnostic log, .m3u8 playlist and chat export are merged into **one dropdown + one 「⬇ 导出」 button** at the bottom of the panel, and the choice is remembered across reloads. Three kinds of content:
  - **📋 Diagnostic log `.txt`** — script version, browser UA, hardware concurrency and the auto-detected thread count, parse results (segment count / duration / encryption / fMP4 / variant list), cache and pending-retry indexes, every setting, the outcome of each run, and **uncaught page exceptions and promise rejections**. Signatures inside playback URLs (`auth_key` / `token` / `sign` / `signature`, in any case variant) are stripped automatically — diagnostic text tends to get pasted straight into public issues, and leaving them in would leak one-time credentials.
  - **📄 m3u8 playlist** — the segment list of the currently selected resolution written as a standard playlist, ready for VLC / ffmpeg / any other downloader, or for archiving. Output is strict HLS: `TARGETDURATION` rounded up to the longest segment, `EXTINF` and segment URLs strictly alternating, `EXT-X-MAP` before the first `EXTINF`, `BYTERANGE` before its own segment URL, a `KEY` declaration (with IV) when AES-128 is in use, and `EXT-X-ENDLIST` at the end. Deliberately no BOM: some parsers would read the first line as a tag name.
  - **💬 Chat** — the full comment history of the replay (up to 20 cursor pages). `.txt` (one `[time] user: message` per line), `.json` (with export timestamp and metadata), `.csv` (BOM-guarded against mojibake), `.html` (opens or prints directly). The endpoint is `https://lv.dingtalk.com/live/listComment`, paged with a `loadMoreId` cursor, `sortType` required.
- **Custom resolution (v1.9.11)**: besides the variants a playlist declares, the dropdown lists common tiers **not exceeding the original resolution** (4K / 1440p / 1080p / 900p / 720p / 540p / 480p / 360p / 270p); a trailing 「自定义…」 entry accepts `宽x高`, including the common hand-typed shapes `1920X1080`, `1920×1080`, full-width digits and a Chinese colon. Whatever you type is matched to the closest real variant — **and when no variant matches exactly it says which one it actually used**, so you are never left thinking you downloaded a resolution you did not ask for.

**Panel**

- **Panel docked into the side column (v3.2.0, off by default)**: switch it on in 更多设置 and the whole panel embeds under the 互动/简介 tabs the moment the page loads (never after parsing; if the column mounts late it retries). The panel joins the flow as the last sibling of the tab bar, so the tabs stay on top and untouched and the content area simply flexes and keeps scrolling. A docked panel switches to a denser layout (measured visible ratio 25% → 54% with everything expanded), and a grip on the top edge resizes it (default 430px, re-clamped when the window shrinks, value remembered). While docked, dragging and window re-positioning are disabled and every geometric value belongs to CSS; the halo keeps hugging the panel. A 1.5s watchdog re-attaches the panel if a React re-render evicts it, and if the side column disappears (narrow window / logged out) the panel falls back to floating and re-docks when it returns.
- **Scrolling and pinned footer (fixed in v3.2.1)**: with the panel docked, content taller than the visible height **scrolls with the wheel** (`.bin` used to be `overflow:hidden`, which pushed the download button 91px and 更多设置 211px below the fold — unreachable), and the **version / 检查更新 footer is pinned to the very bottom of the panel**, always visible without scrolling (it hides itself when collapsed, leaving no empty strip). Both hold in the docked and floating forms.
- **Floating-panel scrollbar (v3.6.2)**: drag the panel into the lower half of the viewport and expand everything, and the usable height drops to about a hundred pixels — a scrollbar appears on the body, stacked on top of a second one inside it. The cap is now measured from the panel's real position, so it is already correct mid-animation; when the panel is docked into the side column it hands the height back to the column.
- **Draggable panel (v2.4.0)**: press the title area (cursor turns into a grab hand) and drag the panel anywhere; the position is remembered across reloads, and it drags while collapsed too (fixed in v2.6.0). **Dragging only starts from blank space** — pressing on an input, select or button leaves native behaviour untouched (v2.6.0 fix; before that the drag region wrapped the whole form and every field and dropdown was dead). **Horizontally** it is clamped inside the viewport so the panel cannot be lost; **vertically** it may leave the viewport, because the expanded panel is routinely taller than the window (600px+), and clamping it there would pin it to the top and read as "dragging is broken". The panel is re-clamped against the last known position on every window resize, so repeated resizing does not accumulate drift.
- **Collapse to a bar**: press 「收起」 when you do not need the panel and it shrinks to a slim horizontal bar at the bottom-right (title on top, progress bar below) without covering the video; click it to expand, and the state persists. The bar is **blue while parsing and green while downloading**, and collapsing mid-download is allowed so you can watch progress. The collapse is a smooth height animation (`grid-template-rows: 1fr → 0fr`) sharing one 280ms spring curve between content and shell, and it respects the OS "reduce motion" setting.
- **Download halo**: while a download runs, a gradient light band (blue → cyan → pink, with a bright segment flowing along the edge) wraps the panel's outermost edge, and wraps the collapsed bar too. It is now a **linear gradient transparent at both ends with its whole coordinate system rotating** — there is no length in it at all, so band width and speed stay constant whatever the panel's size or aspect ratio. **The middle is not painted at all**, so it can never bleed into the panel and blur into a colour block. The halo is a child of the panel sized by `width:100%` / `height:100%`, so the browser itself guarantees it matches — no JS chasing geometry per frame.
- **Enable frosted glass**: **off by default** (since v1.8.0). When on, both the panel and the collapsed bar become translucent with a background blur, letting the player show through; the state persists. In frosted mode the footer's small grey text automatically brightens and gains a text shadow so it stays readable over any content.
- **Keyboard shortcuts (v2.4.0)**: `Space` starts the download and toggles pause/resume while running, `Esc` interrupts a running download and otherwise collapses or expands the panel, `M` toggles collapse. **None of them fire while you are typing** in an input or textarea, so typing an `m` never collapses the panel.
- **更多设置**: the collapsible area at the bottom, **collapsed by default**, holding low-frequency options — thread count, retries, **default panel state (expanded / collapsed)**, prefetch, frosted glass, **automatic update check (on by default)**. The first two and every switch persist via `GM_setValue`. The expand/collapse arrow is a CSS chevron (smooth 90° flip) with a 260ms spring-out transition.
- **Auto-collapse settings while dragging (v2.6.0, on by default)**: collapsible sections fold away while you drag and are restored when you release — the fold-out area only gets in the way during a drag. Turn it off in 更多设置.
- **No save dialog**: the browser writes the file straight to its default download directory (`saveAs:false`), so there is nothing to confirm — and the old system dialog never reported a dismissal back inside Tampermonkey, which made "cancelled but still downloading" unavoidable.
- **Dark theme**: dark by design, with no light or system theme option.

**Performance**

- **Prefetch playback info** (on by default): the csrf token, playback URL and m3u8 segment index are fetched on page load and cached for 10 minutes, so pressing 「下载本页回放」 goes straight to downloading. The filename placeholder is filled in with the parsed replay title.
- **Automatic thread count**: network-IO bound, so the default is CPU logical cores × 2 (clamped to 4–16), faster than a fixed 5 threads; the note in 更多设置 shows the count detected this time. Once you set it manually, your value wins and persists via `GM_setValue`.

**Hand off to a downloader (experimental)**

- **Hand every download to aria2 (v3.4.0, off by default)**: a master switch in 更多设置. When on, **all** download tasks are executed by the local aria2 — pressing 「下载本页回放」 and every item in the queue alike; the panel only parses the segment list and pushes each URL with `addUri`, and the in-page segment fetch / concat / save are all skipped. With it off, behaviour is exactly as before. The switch persists.
- **aria2 settings (v3.3.0)**: the aria2 block in 更多设置 has host / port / secret / save directory plus 「🔌 测试连接」, all persisted (the secret only ever goes into local storage). **aria2 does not support m3u8**, so segments are pushed individually rather than handing over a playlist URL, batched 40 per POST via `system.multicall`. The artefacts are `seg00000.ts …` files and the log prints the matching `ffmpeg -f concat` command.
- **Refuses honestly instead of pretending**: AES-128 encrypted segments (the key only exists in the browser) and fMP4 (separate init segment) are rejected with the reason stated in the status line.
- **Error classes**: `Unauthorized` → check `--rpc-secret`; `Invalid Request` / `No such method` → aria2 too old; unreachable → confirm it is running and the port is right. 「测试连接」 uses `aria2.getVersion` to tell these apart.
- **Security baseline**: 127.0.0.1 + secret only. **Never** rely on `--rpc-allow-origin-all` alone — in the source it does not validate Origin/Host, so any web page could use it to write files onto your disk.

**Versions and updates**

- The panel footer shows the version beside a small grey 「检查更新」 label (no longer a button since v1.9.4). **The automatic check is on by default** (toggle in 更多设置): on page load it compares against the latest release in the background and, when a newer one exists, that label becomes a clickable blue "发现新版 x.y.z ↑". **It never navigates on its own — click to open the update page.** With the automatic check off, pressing it checks manually and you still click once more to reach the download. **If GitHub is unreachable it falls back to the Gitee mirror.**
- **Choose the update source (v1.9.11)**: switch between **Gitee (default) / GitHub / Auto** in 更多设置. Gitee is the default because `raw.githubusercontent.com` is unreliable from mainland China while the Gitee mirror usually is not. Switching re-runs the check immediately.
- Every release is tagged and recorded in [CHANGELOG.md](CHANGELOG.md).

**Protocol compatibility**

- **Multi-bitrate**: `#EXT-X-STREAM-INF` variants are detected and the highest bandwidth is chosen by default; a manual pick overrides it.
- **AES-128**: on `#EXT-X-KEY` the key is fetched via Web Crypto and each segment is decrypted on the fly.
- **fMP4 / BYTERANGE**: supports `#EXT-X-MAP` initialisation segments and `#EXT-X-BYTERANGE` byte ranges.
- **Concurrency** (1–16, auto-detected by default as CPU logical cores × 2, your setting wins once set) and **retries** (1–10, default 3, exponential backoff).

**Miscellaneous**

- **Link parsing fix (v1.9.8)**: pasting a bare query string without a domain (`?roomId=…&liveUuid=…`) no longer fails with "link is missing roomId/liveUuid" — the old fallback prepended another `?`, which glued an extra question mark onto the first parameter name so nothing resolved.
- **Duplicated queue failure prefix (v3.6.3)**: when an item in the download queue failed, the summarised reason carried two layers of `❌ 失败:` — the status line wrote a half-width colon while the stripping regex only accepted a full-width one, so the two never matched. Both widths are accepted now.
- **Punctuation (v3.6.3)**: the script and this document use English full stops throughout; commas, ideographic commas, colons and parentheses inside Chinese prose are left as they are.

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
2. Optionally set **filename** (blank uses the replay title), **output format** and **clip range** (units auto-detected, blank means everything); concurrency and retries live in 更多设置.
3. Once the page has parsed, segments are pre-downloaded in the background and the log reports progress. Pressing 「下载本页回放」 then only has to merge and save; how long that takes depends on how much the pre-download already finished. The status line shows segments `n/N` → merge → save.
4. When the download finishes the status line shows `✅ 完成` and the file lands in the browser default download folder; since v3.2.0 no preview player and no speed control is popped into the panel.
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
- **The download halo's animation can look choppy on high-resolution displays** (reported on 4K / high-DPI). The halo's position and size already hug the panel correctly; only the motion is affected, never the download. The usual suspect — an expensive `stroke-dashoffset` animation — was measured and ruled out: frames cost the same with the animation on or off. Remaining directions and how to verify them are in the CHANGELOG's "Unreleased" section.
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
