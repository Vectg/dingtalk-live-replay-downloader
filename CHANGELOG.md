# Changelog

本文件记录本项目的所有 notable changes.
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/), 
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/).
## [未发布]

### 计划
- **内嵌播放器**:把播放器嵌进钉钉页面自带播放器位置（默认关闭）. **顺延到 3.0.0 之后**,
  需先确认钉钉回放页在未登录/可见权限两种情况下的真实 DOM 结构, 否则只能猜 class 名, 一改版就失效.
- **推送到下载器**（aria2 RPC 等本地下载器集成）:同样顺延到 3.0.0 之后.
## [2.3.0] - 2026-10-04

### 新增
- **截取时间单位自动识别**:时间框不再预设 `mm:ss`, 解析出回放总时长后按需切换——
  不足 1 小时提示 `mm:ss`, 达到 1 小时及以上自动换成 `hh:mm:ss`（小时位不限 99,
  可填 `100:00:00`）, 框内灰字提示随总时长实时更新.
- **失焦自动补零**:离开时间框时把 `1:2:3` 规范成 `01:02:03`, `1:2` 规范成 `1:02`.
  全角数字/中文冒号/空白/零宽字符照旧自动修复.
### 修复
- 规范化函数遇到四段输入（如 `1:2:3:4`）时会**静默截断成 `01`**, 用户输入被篡改.
  现在非法层数与非法字符一律原样返回, 交由 `parseTimeArg` 明确报错.
### 技术细节
- 两段写法（`1:30`）在 `mm:ss` 与 `hh:mm` 之间天然歧义, **刻意不做猜测性改写**——
  补成三段会把 90 秒变成 1 小时 30 分. 一律按 `mm:ss` 解析, 超限时错误信息给出可用写法.
- 零宽字符（U+200B/200C/200D/FEFF/00A0/3000）用**码点数值**过滤, 不写进正则字面量:
  编辑工具改写文本时会悄悄吃掉其中一个（U+200B 就这么丢过一次）, 码点不会被文本层影响.
- 总时长从 `prep()` 传给面板的 `init()`, 两者是兄弟函数作用域不通, 故走模块级钩子 `onClipDur`.
## [2.2.1] - 2026-10-04

### 新增
- **`CHANGELOG.md` 入库**:按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式,
  1.2.0 – 2.2.0 全部回填, 末尾附 compare 链接块.
### 修复
- `CHANGELOG.md` 里 `[1.6.8]` 链接定义重复出现两次（compare 链接后又追加一条指向修复提交的
  commit 链接）, 重复定义会被渲染器忽略, 属无效写法.
- 补上唯一缺失的 tag **`v1.6.8`**（此前 34 个版本提交只有 33 个 tag）, 打在 `add0163`
  ——即 1.6.9 之前的最后一个提交, 与其它版本边界一致.
- 更正 CHANGELOG 里「1.6.8 无单一发布点」的说法: 实际边界干净, 不必特指某次提交.
### 文档
- `README.md` 顶部加入 `CHANGELOG.md` 链接（徽章 + 版本号）.
## [2.2.0] - 2026-10-04

### 新增
- **帧级精确截取（实验性）**:更多设置里开启（默认关）.切片对齐只能精确到切片长度
  （通常 30 秒）,开启后逐帧解析视频流找出全部关键帧,把起止点对齐到离目标最近的 IDR.
  fMP4 回放不支持（无 TS 包结构）,关键帧不足时自动退回切片对齐结果.
### 技术细节
- TS → PES → AnnexB 解析,识别 IDR（NAL type=5）并取 PTS 建立时间轴.
- 切点落在 TS 包边界而非 PES 内偏移——否则切出的是裸流,解复用器从头对不齐.
- 启用时先下载完整回放再裁剪:帧级精修靠「第一片对应回放 0 秒」建立时间轴基准, 
  用裁过的切片会导致基准错误且拿不到区间外的关键帧.
- 中途切出的流重新封装 SPS/PPS 插到输出开头,并沿用原视频流 PID.裸粘 NAL 字节会
  破坏解复用器的包对齐,症状是 `non-existing PPS` 加开头若干帧解码失败.
## [2.1.0] - 2026-10-04

### 新增
- **智能调度**（更多设置,默认开）
  - 贪心取片顺序:抽样探测头尾各若干片的真实体积（1 字节 Range,不下载整片）, 
    体积大的先下.整体完成时间由最慢的一片决定,先啃硬骨头能压缩尾部.
  - 并发自适应:从设定线程数起步,连续成功逐级加到 16,有失败立刻降并发退避, 
    恢复后再爬回去.
### 修复
- 并发控制器的一次失败会永久抑制后续加并发（`winFail` 标志形成死锁）.
- 窗口结算只看时间,极快网络下同一毫秒算不出平均速度,导致并发卡死.
## [2.0.0] - 2026-10-04

### 新增
- **下载队列**:链接输入框下方可填多行队列（每行一个回放）,按顺序依次下载完.
  - 行格式宽松:整段 URL、裸查询串、`roomId liveUuid`、`roomId=x liveUuid=y`.
  - 空行与 `#` 注释行忽略;无法识别的行单独报出并指出第几号.
  - 单个回放失败不中断整队,最后汇总「成功 N · 失败 M」.
  - 刻意顺序执行而非并发:并发只会让多个回放互抢带宽、一起变慢.
### 修复
- 队列汇总曾把全部失败误报为「成功」: `run()` 自己 catch 掉异常不向外抛, 
  调度器靠 `try/catch` 判定失效.改为由 `run()` 显式回写结果标志.
## [1.9.12] - 2026-10-04

### 新增
- **导出 m3u8 播放列表**:把当前选中分辨率的切片列表存成标准播放列表, 
  便于用 VLC / ffmpeg / 其他下载器重新拉取或存档.严格按 HLS 规范输出.
## [1.9.11] - 2026-10-04

### 新增
- **一键导出诊断日志**:生成 `.txt`,含版本、浏览器 UA、硬件并发、解析结果、
  缓存与待重试片号、各项设置、每次下载成败,以及页面未捕获的异常与 Promise 拒绝.
  播放地址里的签名自动抹除——诊断文本常被直接贴到公开 issue.
- **自定义分辨率**:下拉列出不超过原始分辨率的常用档位（4K 到 270p）; 
  「自定义…」可手填宽×高,支持 `1920X1080` / `1920×1080` / 全角数字 / 中文冒号.
  匹配不到正好这一档时明确告知实际用了哪一档.
- **自选更新源**:更多设置可切 Gitee（默认）/ GitHub / 自动.
### 修复
- 中文冒号被转成半角冒号而非 `x`,导致合法分辨率输入被拒.
- 全角数字未转换,同上.
## [1.9.10] - 2026-10-04

### 新增
- **只重试失败切片**:失败后按钮出现,写明片数与片号,点它只补这几片.
  走的是断点缓存（IndexedDB）,跨刷新、关页后依然有效.
### 变更
- 预览移除音量滑块:原生 `controls` 已带音量按钮,倍速保留.
## [1.9.9] - 2026-10-04

### 新增
- **完成/失败系统通知**:走 `GM_notification`,标题点明成功/失败, 
  正文带文件名与体积;点通知回到面板.
- **提示音**: WebAudio 现场合成（完成两声上行、失败三声下行）,不引外部音频文件.
  默认关闭——浏览器自动播放策略常拦默认开的声音,容易让人以为坏了.
### 修复
- 失败提示音原本算成**上行**,与「失败」语义相反.
## [1.9.8] - 2026-10-04

### 新增
- **单元测试 harness**: `test/extract.js` 从已发布的 `.user.js` 原样抽取函数源码执行, 
  测试跑的就是用户真正装到 Tampermonkey 里的那份代码.
- **GitHub Actions CI**: `node --check` + 单元测试 + 版本守卫
  （改了脚本却没 bump `@version` 就让 CI 失败）.
### 修复
- 解析裸查询串 `?roomId=.&liveUuid=.` 时,回退分支会把开头的 `?` 再拼一次, 
  参数名带上多余问号而取不到.
## [1.9.7] - 2026-10-04

### 新增
- **体积预估**: `Range` 拉首片 1 字节读 `Content-Range` 得单片总大小, 
  解析阶段即显示预计体积.
- **输出完整性校验**:逐片校验数量、非空、TS 同步字节 188 周期对齐.
  发现异常只把问题片置空、好片保留为断点缓存,重下只补这几片.
## [1.9.6] - 2026-10-04

### 新增
- 断点缓存写入 **IndexedDB**:刷新页面或关页后仍可续传.
## [1.9.5] - 2026-10-04

### 修复
- 毛玻璃模式下页脚灰色小字看不清.
## [1.9.4] - 2026-10-04

### 变更
- 检查更新改造:页脚灰色小字、自动检查默认开、发现新版才变可点、手动点击才跳转.
## [1.9.3] - 2026-10-04

### 修复
- 面板状态显示错位:下拉框与实际状态不同源,存储值未归一化.
## [1.9.2] - 2026-10-04

### 新增
- 并发线程自动识别: `hardwareConcurrency × 2`,钳制 4–16.
### 修复
- `bindNum` 越界时未回退默认值.
## [1.9.1] - 2026-10-04

### 新增
- 暂停 / 继续 / 中断 / 删除已下载,下载中显示实时速度与预计剩余时间.
## [1.9.0] - 2026-10-04

### 新增
- **原始分辨率自动分析**: Range 拉首片前 64KB → TS 解包 → H.264 SPS 解析
  （支持 Baseline/Main/High 与裁剪参数）,下拉第一项直接显示实际分辨率.
## [1.8.1] - 2026-10-04

### 新增
- hover 阴影层、收起条毛玻璃、输出历史展开.
## [1.8.0] - 2026-10-04

### 新增
- 收缩横条（双色进度:蓝=解析,绿=下载）、分辨率选项、截取全量校验、面板状态选项.
## [1.7.2] - 2026-10-04

### 新增
- 预取播放信息（10 分钟缓存）、更多设置面板、文件名回填回放标题.
## [1.7.1] - 2026-10-04

### 修复
- 收起/展开动画高度不平滑,内容与外壳不同步.
## [1.7.0] - 2026-10-04

### 变更
- 光环改 SVG 渐变流光;去掉保存对话框,直接存浏览器默认下载目录.
## [1.6.9] - 2026-10-04

### 修复
- 光环重构为独立 fixed 层,彻底修复不可见 / 透色块问题.
## [1.6.8] - 2026-10-04

### 修复
- 光环从半透明面板透出糊成大色块.
### 重要
- 这次修复曾**忘记 bump 版本号**,导致 Tampermonkey 用户收不到更新.
  该教训直接催生了 1.9.8 的 CI 版本守卫.
## [1.6.7] - 2026-10-04

### 修复
- 收缩/展开动画崩坏、光环错位、点取消后保存卡住.
## [1.6.6] - 2026-10-04

### 新增
- 下载光环、收缩过渡动画、底部版本号与检查更新、Gitee 镜像.
## [1.6.5] - 2026-10-04

### 修复
- 文件名留空时回退、收缩卡住、下载旋转光圈.
## [1.6.4] - 2026-10-04

### 新增
- 文件名输入框、状态框改单行、收缩图标、作者标注.
## [1.6.2] - 2026-10-04

### 变更
- 毛玻璃默认开启.
## [1.6.1] - 2026-10-04

### 新增
- 毛玻璃面板开关、README 分组重排.
## [1.6.0] - 2026-10-04

### 新增
- 截取时长、内置预览（倍速/音量）、深色 UI.
- **MP4 duration 修补**: `mux.js` 输出的 `moov` 里 duration 是 `0xFFFFFFFF` 哨兵, 
  播放器会显示成十几小时、进度条拖不动.脚本遍历 `moof` 用 `tfdt + Σtrun`
  算出真实时长写回,文件大小不变.
## [1.4.0] - 2026-10-03

### 新增
- fMP4（`#EXT-X-MAP`）支持、`#EXT-X-BYTERANGE` Range 请求、
  失败诊断（URL + 原因 + 建议）、mux.js 沙箱安全的全局查找.
## [1.3.1] - 2026-10-03

### 新增
- `@updateURL` / `@downloadURL`,支持自动更新.
## [1.3.0] - 2026-10-03

### 变更
- 移除 `@require mux.js`,改为懒加载（避免启动依赖外部 CDN）.
- `@run-at document-idle`,更稳健的 body 挂载.
## [1.2.0] - 2026-10-03

### 新增
- AES-128 加密切片、多码率 m3u8、稳健的 URL 解析.
---

注: 1.5.0 不存在——其 MP4 duration 修补工作并入 1.6.0 一并发布.
1.6.3 不存在——该版本号被一次未 bump 的提交占用,修复落在 1.6.4.
1.6.8 的修复跨了两次提交（`a517679` 首次修改, `add0163` 补上漏掉的版本号 bump）,
tag `v1.6.8` 打在 `add0163`——即 1.6.9 之前的最后一个提交, 边界与其它版本一致.
[未发布]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.3.0.HEAD
[2.3.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.2.1.v2.3.0
[2.2.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.2.0.v2.2.1
[2.2.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.1.0.v2.2.0
[2.1.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.0.0.v2.1.0
[2.0.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.12.v2.0.0
[1.9.12]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.11.v1.9.12
[1.9.11]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.10.v1.9.11
[1.9.10]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.9.v1.9.10
[1.9.9]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.8.v1.9.9
[1.9.8]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.7.v1.9.8
[1.9.7]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.6.v1.9.7
[1.9.6]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.5.v1.9.6
[1.9.5]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.4.v1.9.5
[1.9.4]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.3.v1.9.4
[1.9.3]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.2.v1.9.3
[1.9.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.1.v1.9.2
[1.9.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.0.v1.9.1
[1.9.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.8.1.v1.9.0
[1.8.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.8.0.v1.8.1
[1.8.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.7.2.v1.8.0
[1.7.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.7.1.v1.7.2
[1.7.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.7.0.v1.7.1
[1.7.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.9.v1.7.0
[1.6.9]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.8.v1.6.9
[1.6.8]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.7.v1.6.8
[1.6.7]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.6.v1.6.7
[1.6.6]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.5.v1.6.6
[1.6.5]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.4.v1.6.5
[1.6.4]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.2.v1.6.4
[1.6.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.1.v1.6.2
[1.6.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.0.v1.6.1
[1.6.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.4.0.v1.6.0
[1.4.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.3.1.v1.4.0
[1.3.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.3.0.v1.3.1
[1.3.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.2.0.v1.3.0
[1.2.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/4bbb374.v1.2.0