# Changelog

本文件记录本项目的所有 notable changes.
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/).
## [3.6.1] - 2026-10-06
### 修复
- **内嵌到侧栏后面板右缘的白底滚动条**: `.bin` / `.body` 规则里写了标准属性 `scrollbar-width:thin`, Chromium 见到标准属性就忽略同规则的 `::-webkit-scrollbar` 深色定制, 滚动条渲染回浏览器默认白底样式 (白轨 + 灰滑块, 与深色面板割裂; 截图像素实测: 滑块 319/540 反推内容约 915px, 正是 `.bin` 更多设置全开的实测高度). 内嵌态现在直接隐藏这两处滚动条外观 (`scrollbar-width:none`); 滚轮 / 触摸板 / 键盘滚动全部保留, 悬浮态外观不变.
### 修复 (兜底)
- 若面板把钉钉侧栏列撑得比视口高、列自身冒出原生滚动条, 内嵌期间同样隐藏: dock 后沿祖先链找第一个真正溢出的滚动容器打 `data-dlr-nosb` 标记交给 CSS, 1.5s 守护每拍幂等重打 (列布局变化 / React 重建后仍生效), undock / 侧栏消失时摘除. 只藏外观, 不改任何布局与滚动能力.

## [3.6.0] - 2026-10-06
### 变更
- **导出合并为一个**：面板底部的「📋 导出诊断日志」「📄 导出 m3u8」「💬 导出聊天记录」三个按钮连同聊天格式小下拉, 合并为**一个下拉 + 一个「⬇ 导出」按钮**. 下拉按内容分组: 诊断日志 (.txt)、m3u8 播放列表 (.m3u8)、聊天记录 (.txt / .json / .csv / .html), 选好点导出即可; 当前选择写入本地存储, 下次打开保持.
### 重构
- 三个导出逻辑抽成 runDiagExport / runM3u8Export / runChatExport 三个命名函数, 由统一按钮按选择分派 (聊天格式从下拉值拆出, 不再依赖独立格式下拉); 进度提示 (⏳ 生成中 / ⏳ 拉取中)、禁用与失败恢复统一走这一个按钮, 导出内容与改动前一致.

## [3.5.3] - 2026-10-06
### 修复
- v3.5.2 把手移到顶边后拖动方向反了: 面板底边锚定在列底, 而旧公式是按底边把手写的 (下拉 = 变高), 顶边把手因此在下拉时往上跑. 现在**顶边把手直接跟随指针**: 下拉 = 变矮, 上推 = 变高. 同时根治同源的参照错位: 拖动起点 / 落点回写 / 窗口缩放重夹原先都拿面板外框高度 (含内边距) 当内容高度, 起手与松手瞬间会虚跳一个内边距的 δ, 现统一取 .body 实高或走 __dockSyncHeight 单一入口.
### 备注
- 之前报告的多余滚动条确认已随 v3.5.2 一并消失 (把手从 bottom:-5px 收回面板内, 不再伸出 .body 边界 5px 撑出滚动条), 本版无需额外改动.

## [3.5.2] - 2026-10-06
### 变更
- 内嵌态的拖动调高把手从面板**底边**移到**顶边** (不必再探到面板底部); 拖动语义不变 —— 往下拖变高, 高度范围 / 持久化逻辑不变. 悬浮态下把手本就只对内嵌态生效, 现在直接隐藏, 顺带让出悬浮标题栏顶部的拖动区域.

## [3.5.1] - 2026-10-06
### 移除
- 「⬇ 发送到 aria2」按钮及其整条点击逻辑: 更多设置的「下载交给 aria2」总开关打开后, 点「下载本页回放」与队列任务已全部交由本机 aria2 执行, 独立按钮成为冗余入口. aria2 区块 (主机 / 端口 / 密钥 / 保存目录 / 测试连接) 不受影响.

## [3.5.0] - 2026-10-06
### 新增
- **聊天记录导出（实验性）**：面板底部「💬 导出聊天记录」一键拉取回放聊天的全部评论历史（最多 20 页游标）. 支持导出格式：`.txt`（逐条「[时间] 用户: 内容」）、`.json`（带导出时间戳与元信息）、`.csv`（BOM 防乱码）、`.html`（可直接双击查看/打印）. 接口逻辑实测：GET + `loadMoreId` 分页获取, `sortType` 必填; POST 返回 405, 缺参数 400; 网页登录态身份返回 errorCode 19004, 实测无法拿到内容, 面板如实报错不伪造.
### 修复
- 恢复 v3.4.0 中被一次旧底稿整体覆写误删的两个功能块（内嵌面板拖拽调高度, aria2 发送按钮及其处理逻辑）, 并清掉 3.4.0 遗留的一处重复 `dockHost = host;` 赋值.

## [未发布]


### 后续计划（3.0.0 之后）

- **推送到下载器**: aria2 RPC 等本地下载器集成.
- **视口自适应深度优化**: 已于 3.0.3 补齐 —— 窗口缩放后会重新钳制面板位置, 不再出现
  「拖到边缘后缩窗, 面板跑出屏幕且无法拖回」. 高度上限本就用 CSS `calc(100vh - 140px)`,
  实测会自动重算, 无需 JS.
- **下载光环动画卡顿**（用户于 3.0.9 验收时反馈, 视觉已修好但动画不顺）:
  - **已测到的事实**: 在 1280×1000 / DPR=1 的合成环境里逐项对比, 四种配置
    （原样 / 关 drop-shadow / 关 dash 动画 / 整个光环隐藏）的帧间隔中位数
    全是 16.7ms, p95 ≤ 17ms, **无一帧超过 32ms** —— 即在测试环境中光环不产生任何掉帧,
    `filter` 与 `stroke-dashoffset` 动画的实测开销均为 0.00ms. 真实设备上才卡,
    说明成因与测试环境不同, **不要按「dash 动画太重」这类猜测去改**.
  - **待查方向**（按可能性排序, 逐个验证而不是一次性全改）:
    1. **`filter: drop-shadow()` 在高 DPR 下的光栅化开销**. 光环 SVG 约 366×624px,
       在 DPR=2 的 4K 屏上等于 732×1248 物理像素, 每帧都要重新光栅化一个大面积模糊.
       验证方式: 临时 `filter:none` 让用户在真实设备上对比. 若确认卡顿,
       改用不带 filter 的方案（把光晕画成第二描边而非模糊）, 或只在低 DPR 时启用.
    2. **`stroke-dashoffset` 动画触发的重绘范围**. 光带沿 1938px 周长移动, 每帧
       可能让整条 SVG 重绘. 验证方式: 换成只动 `transform` 的方案, 或用
       `will-change` / 独立合成层提示浏览器.
    3. **与下载并发抢主线程**. 下载时 16 线程并发解码 + 切片合并都在主线程,
       光环动画排在后面被推迟. 验证方式: 暂停下载后再看动画是否顺滑;
       若确实如此, 应把光环动画与下载状态解耦（如空闲时降低帧率）.
  - **约束**: 任何修改都要保持 v3.0.9 已验证的性质 —— 光环贴合**可见面板**（`.body`,
    收缩态用 `.expand`）, 差距 `[-1,-1,2,2]`; 且必须过 `prefers-reduced-motion`.
## [3.4.0] - 2026-10-05

### 新增
- **内嵌高度可拉伸**: 面板内嵌后底边出现把手, 上下拖动调整高度 (默认 430px). 上限按「页签条以下到列底」
  实测 581px, 窗口缩小时自动收进可用范围, 高度持久化 (`dlr_dock_h`). 收起成横条时把手隐藏.
- **队列框的文字永远读得完**: 你要的「不能缩小到盖住所有文字」落在队列输入框自身 —— 给它
  `min-height:42px` 兜底(手动 resize 也拖不到更小), `overflow-y:auto` 让多行链接在框内滚动.
  实测依据: 20px 高时 scrollHeight 48 > clientHeight 19, 文字被静默藏起来.
- **「下载交给 aria2」总开关 (实验性, 默认关闭)**: 打开后**所有**下载任务交给本机 aria2 ——
  「下载本页回放」与队列里的每个回放都一样, 面板只解析并逐条 `addUri`, 浏览器内的切片下载/拼接/保存
  全部跳过; 关闭时行为完全不变. 按钮路径与总开关共用 `aria2PushAll`, 不复制逻辑.

### 修复 (两个真 bug, 都是浏览器验收抓出来的)
- **收起态面板吃满整条侧栏 (629px)**: 内嵌高度的第一版把 `min-height:318px` 写在 `.body` 上,
  而收起态 `.body` 是 `grid-template-rows:0fr`, min-height 直接把它顶开, 叠加 `max-height:none`
  后面板占满侧栏. 现在下限只落在**队列框自身**, 面板高度一律由 `--dlr-dock-h` 表达, 收起时
  `height:auto` 且把手隐藏; 实测收起回到 56px、展开还原 438px.
- **开启总开关后每次下载都报「aria2 配置尚未初始化」**: `run()` 里写了
  `typeof arConfig === 'function'`, 但 `arConfig` 是 `init()` 内的局部 const, `run()` 根本看不到它,
  判定永远为假. 配置读取已提到模块级 `aria2Config()`, 面板 UI 与 `run()` 共用同一份.
- 另一处同源错误: gate 最初插在 `const { model, parsed } = ...` 之前, 引用了尚未初始化的 `parsed`,
  报 `Cannot access 'parsed' before initialization`; 现已移到解构之后.

### 测试
- 浏览器真机验收 (登录态真实回放页 + GM 桩): 收起 56px 且下方留白 400px+ (不再沾满侧栏)、
  拖动上限 581px 正好贴侧栏底、拖到下限 346px 时标题与下载按钮仍在可视区、队列框 42px 兜底、
  aria2 总开关开启后 1 次 `system.multicall` 推送 6 条 `addUri` (token 在 `params[0]`、out/dir/header 齐全)
  且**浏览器内下载 0 次**、日志给出 ffmpeg 合成命令, `window.__errs` 为 0.
- 单测 445/445 不变 (本版未新增纯函数).


## [3.3.1] - 2026-10-05

### 新增
- **发送到 aria2（实验性）**: 面板底部「⬇ 发送到 aria2」按钮, 把当前分辨率的**每个切片 URL 逐条**
  交给本机 aria2 (`aria2.addUri`, 用 `system.multicall` 每批 40 条一次 POST). 更多设置里新增
  aria2 区块: 主机 / 端口 / 密钥 / 保存目录 + 「🔌 测试连接」, 设置持久化 (密钥只写本地存储).
  aria2 不支持 m3u8, 所以逐条推送; 产物是 `seg00000.ts …` 切片文件, 日志给出 `ffmpeg -f concat` 合成命令.
- **拒绝而不是假装能推**: AES-128 加密切片 (密钥只在浏览器里) 与 fMP4 (含独立初始化段) 直接拒绝
  并在状态栏说明原因, 而不是推一批下不下来的任务.
- **错误分类**: `Unauthorized` → 核对 `--rpc-secret`; `Invalid Request` / `No such method` → aria2 版本;
  网络错误 → 确认已启动与端口. 测试连接用 `aria2.getVersion` 区分.

### 变更
- **内嵌态紧凑排版**: 实测「更多设置全部展开」时内容 937px、侧栏可见仅 237px (只能看到 1/4).
  新增一整段 `.docked` 专属 CSS: 行距 3→1px、区块间距 5→3px、控件高度与字号各收一档、
  状态栏/进度条/页脚缩小、队列输入框 2 行→1 行、aria2 区块与说明文字收紧; 滚动区上限
  `min(300px,42vh)` → `min(430px,62vh)`. 结果: 可见比例 **25% → 54%** (内容 698px / 可见 376px),
  收起 56px 与展开还原不变, 页脚钉底与页签不被遮挡均保持. **悬浮态完全不受影响** (实测面板
  722px、输入框字号仍 12px、行距仍 3px).

### 测试
- aria2 纯函数抽出并跑 55 条断言 (落盘名补零、`options` 合并与空值省略、`system.multicall` 请求体里
  `token` 必须在 `params[0]`、无密钥时不占位、错误文案映射、95 片按 40 分 3 批且顺序不打乱),
  验收 390 → 445.
- 真机验收: 本机便携版 aria2 1.37.0 真实 RPC (`getVersion` 200 / 错密钥 `Unauthorized`),
  6 条 `addUri` 经 `system.multicall` 全部返回 gid; 浏览器端填参持久化、测试连接、推送按钮与错误
  分类均验证, `window.__errs` 为 0.

### 排查记录
- **研究文档里「浏览器不会被 CORS 拦」不成立**: 用页面 `fetch` 打 `127.0.0.1:6801` 时, aria2 不回
  CORS 头, 浏览器把请求挂住不返回 (表现为按钮一直转). 真机上必须走 `GM_xmlhttpRequest`
  (扩展特权请求不受页面 CORS 限制) —— 这正是本脚本一直用它的原因. 验收时需要带 CORS 头的中继
  才能让页面 fetch 打通, 但产品代码不应依赖它.
- **aria2 拉到文件但 errorCode=18 (Download aborted)** 时先看**源站是否真的返回字节**:
  本次是测试用的 `python -m http.server` 对所有请求都返回 `size 0`, aria2 因此中止 —— 不是
  addUri 参数问题. 判据: 先用 curl 确认 `size_download` 非 0, 再看 aria2 的 `errorMessage`.


## [3.2.1] - 2026-10-05

### 修复
- **内嵌后看不到下面的功能**: `.bin` 是内容包裹层, 此前 `overflow:hidden` 把超出部分裁死, 而 `.body` 的
  `scrollHeight == clientHeight`（299 == 299）所以它自己永不滚动 —— 实测内容 530px / 可见 271px,
  下载按钮被压在可见区下方 91px、更多设置 211px, 用户点不到. 改为 `overflow-y:auto`（横向仍隐藏）
  并补细滚动条样式, `.bin` 成为真正的滚动区（实测 scrollHeight 496 / clientHeight 237, 可滚 239px,
  滚到底后下载按钮完整落在可视区内）.
- **版本/检查更新栏不再需要滚到底**: 页脚原在 `.bin` 内部, 内嵌态实测位于 y=926 而面板底在 705（低 245px）,
  又因为上一条无法滚动, 等于永远看不见. 现将 `.foot` 移出 `.bin`、作为 `.body` 直接子块, 由 grid
  钉在面板底部; 实测滚动时页脚位移 Δ=-0.7px（钉住）, 始终在面板内; 收起态 `display:none`, 不留 24px 空条.
- **悬浮收起态的透明空壳**: `applyPos` 原先把坐标反算成 `right`/`bottom` 像素值一并写入, 于是 top 与
  bottom 同时存在 —— CSS 对「height:auto + top + bottom」会把 shell 高度钉成「视口 − top − bottom」,
  实测收起态 shell 高 570px 而内容只有 48px, 一块看不见的大壳子盖住右下角并吃掉那里的点击.
  `posToRightBottom` 改为只返回 `left/top`, `right/bottom` 写 `auto`; 实测收起态 48px、shell 高度等于
  内容高度、横条下方 150px 处命中页面元素而非面板.

### 测试
- 5 条写死旧契约的断言（right/bottom 反算）改为新契约断言, 并在断言名里写明原因; 验收 389 → 390.
- 浏览器真机验收 (登录态真实回放页 + GM 桩): 内嵌收起 56px / 展开还原 308px、悬浮收起 48px、
  拖拽位移 -100/-42、`.bin` 可滚且下载按钮滚到底可见、页脚钉住（Δ=-0.7px）、resize 重钳制稳定,
  `window.__errs` 为 0.

### 排查记录（重要, 别再踩）
- **后台标签页会冻结 CSS 过渡, 制造假的测量结果**: CDP 下标签未在前台时
  `document.visibilityState === 'hidden'`, `performance.now()` 照常走, 但所有 CSS 过渡/动画的
  `currentTime` 冻结在 0 —— 收起态读到的 `grid-template-rows` 永远是起始值, 于是量出「收起后 356px」
  「悬浮收起 570px」这类**并不存在的高度**, 还差点据此去改产品代码. 判据: `getAnimations()` 里
  每条都是 `running` 但 `currentTime === 0`, 且 `document.getAnimations()` 同样全为 0.
  修法: 测量前 `Page.bringToFront` + `Emulation.setFocusEmulationEnabled(enabled:true)`,
  之后动画立即跑到终点（rows 0px / body 0 / 面板 56px）.
  **任何涉及过渡动画的验收都必须先确认 `document.visibilityState === 'visible'`.**


## [3.2.0] - 2026-10-05

### 新增
- **面板内嵌互动/简介侧栏 (实验性, 默认关闭)**: 更多设置里打开「面板内嵌侧栏」后, 整个面板在**页面加载时**立刻挂到右侧「互动/简介」页签下方 (不是等解析完才嵌, 侧栏晚上线时 15s 内每秒重试). 定位只用结构+几何+页签文本 —— `#live-room` 里不含播放器、且首个「高≤64px、落在列内、非 absolute、文本含互动/简介」的节点即页签条, 取其父容器挂载; 绝不碰 CSS-module 哈希 class (每次发版都会变), 绝对定位覆盖层整棵剪掉.
- **不遮挡旁边内容 (用户硬要求)**: 面板是页签条父容器的**流内最后一个子块**, 页签固定在上、内容区 `flex:1 1 0%` 自行让位且照常滚动. 实测 (1469 与 1180 两种视口): 页签条 50px, 面板 319/320 宽贴列内, 页签点 hitTest=TAB、内容点=CONTENT 互不遮挡, 点「简介」照常切换内容, 面板上沿 = 内容区下沿 (零重叠).
- **收起即还空间**: 内嵌态点「收起」后面板只剩横条 (56px), 内容区 273px → 525px; 展开还原 273px.
- **看门狗**: 每 1.5s 校验面板是否还在宿主里, React 切页签/重渲染把它甩掉就挂回去 (实测 2.4s 内恢复); 侧栏整个消失则退回悬浮并写日志, 侧栏回来再挂上. 开关状态持久化 (`dlr_dock`), 未登录页没有侧栏时保持悬浮并回写开关.

### 变更
- **内嵌态禁用拖拽与窗口重定位**: 几何全部由 CSS (`position:relative; inset:auto; width:100%!important`) 拥有 —— `applyPos` 与 mousedown 两处早退; 回到悬浮时恢复拖过的坐标 (实测 `967,184` 正确回放), 内联 left/top/right/bottom 清空.

### 移除
- **下载后预览整体移除, 含倍速播放** —— 用户 2026-10-05 指示: 「解析视频完成之后就不要再给面板里面塞个视频了, 去除掉这个功能, 包括倍速播放」. 移除范围: 面板内预览 `#dlr-preview` 及其 0.5×–2× 倍速控件、3.1.0 的「内嵌播放器预览」(含开关与预览浮条的「位置」选择)、全部相关 CSS/HTML/调用点; `showPreview` / `showPreviewEmbed` / `embedAnchor` / `nativeVideoInPlayer` / `playbackRate` 全文 0 命中. 下载完成只留 `✅ 完成` 状态与日志, 文件照旧存入浏览器默认下载目录.
- 「拖动时自动收起」不再涉及预览区 (预览区已不存在).

### 测试
- `dockMount` 抽出后跑 8 条断言 (实测结构 / 扁平结构 / absolute 覆盖层被剪 / 无页签条 / 越界页签条 / 无 live-room / 列文本无页签词 / 播放器列跳过), 验收总数 381 → 389.
- 浏览器真机验收 (登录态真实回放页 + GM 桩 + ffmpeg 6 段真 TS): 加载即内嵌、页签与内容互不遮挡 (hitTest)、页签点击切换、内嵌态拖拽位移 0/0、收起与展开空间往返、开关往返 (回浮可拖 + 坐标回放 + 内联清空)、看门狗 2.4s 挂回、下载完成面板内 0 个 video / 0 个倍速控件 / 无预览 DOM、光环仍按 `.body` (环框 = body±3 = 设计外扩, 描边落在 3.0.9 规格), 1180 窄视口重注入即内嵌且恢复视口后仍内嵌, 全程 `window.__errs` 为 0.


## [3.1.0] - 2026-10-05

### 新增
- **内嵌播放器预览（实验性, 默认关闭）**: 更多设置里新增「内嵌播放器(实验性)」开关. 开启后
  MP4 下载完成的预览不再挤在面板小窗, 而是铺满钉钉自带播放器的槽位 (实测 1002×564).
  预览框用 CSS `left/top/right/bottom:0` 贴合, 窗口缩放自动跟随 —— 不做 JS 几何同步
  (v3.0.9 的教训: 能让 CSS 拥有几何就别用 JS 追). 打开预览时暂停原生播放, 避免两条音轨叠加;
  关闭预览时按打开前记录的现场恢复原生播放. 连续两次内嵌共用同一份暂停现场, 第二次不会把
  「原来是否在播」覆盖掉.
- **两个内嵌位置, 预览内实时切换**: 预览右上角新增「位置」下拉, 「播放器 / 互动·简介侧栏」
  随时切换并记住 (GM `dlr_embed_slot`), 下次预览沿用上次的位置. 侧栏位铺满右侧互动·简介列
  (实测 320×632, `position:relative`, 同样 `inset:0` 贴合, 实测偏差 0,0,0,0); 侧栏没有稳定 id,
  所以按结构定位 —— `#live-room` 的子列里不含播放器、且带「互动/简介」页签文本的那一列,
  找不到就换另一个位置, 都没有才退回面板内预览. 原生 video 始终从播放器槽位取,
  否则侧栏位下暂停/恢复会失灵.
- **锚点只认页面稳定 id**: 优先 `#ding_live_player`, 兜底 `#J_player`, 都没有 (未登录页
  播放器不挂载) 就退回面板内预览. 绝不碰 `_903bde0b01` 这类 CSS-module 哈希 class ——
  每次发版都会变. DOM 结构取自 2026-10-05 登录态实测, 全是 light DOM, 无 shadow root.
- 浮条: 预览框右上角给 位置 + 文件名 + 倍速 (0.5×–2×) + 关闭按钮, `textContent` 构建,
  不走 `innerHTML`. z-index 只压过页面内容, 不越过面板自身的 999999, 面板拖到播放器上方仍可点.

### 修复
- 换场/换槽时上一条预览的 blob URL 未吊销, 连续挂载会泄漏 (随版发布).

### 测试
- `embedAnchor` 抽出后跑 12 条断言 (播放器位优先级 / 缺主锚点兜底 / 全缺返回 null /
  side 位取列规则 / 无页签文本不猜 class / 无 `#live-room` 返回 null),
  验收总数 381 → 393.
- 浏览器端真机验收 (登录态真实回放页 + GM 桩 + ffmpeg 生成的 6 段真 TS 夹具):
  五个场景全绿 —— A 播放器位 (几何偏差 0,0,0,0) / S 实时切侧栏 (0,0,0,0) /
  C 关闭后原生恢复播放 / B 关开关回退面板预览 / F 侧栏被移除时回退播放器位;
  预览帧 canvas 采样 4773/4800 彩色像素, 证明 mux.js 转出的 MP4 真的能解码出画面.

## [3.0.9] - 2026-10-04

### 修复
- **下载光环: 参照对象选错了, 这才是真正的根因**. 之前三次改动（v3.0.2 加
  ResizeObserver、v3.0.5 改成 CSS 定位的子元素、v3.0.7 换成旋转渐变）都在修「同步」，
  但同步从来不是问题 —— `#dlr-panel` 只是**外壳**: 它有 `padding:14px 16px` 且
  `background:transparent`, 自身完全不可见; 用户看到的深色圆角面板是它内部的 `.body`.
  光环一直按外壳的盒子画, 于是永远比可见面板大出一圈内边距（实测左右各 16px、
  上下各 14px）, 看起来就是「在外面框出一大块地方」.
  现改为按**可见面板**取几何: 展开态用 `.body`, 收缩态 `.body` 被压成 0 高
  （`grid-template-rows:0fr`）时改用 `.expand` 横条, 两者都不可用才退回外壳.
  **保留 v3.0.8 回滚后的实现（独立 fixed 层 + JS 同步 + 按真实周长算 dasharray）,
  只换参照对象, 不再动机制.**

### 验证
- 光环与**可见面板**的差距: 展开/更多设置开合/收缩成横条/再展开 四种场景均为
  `[-1,-1,2,2]`（描边落在面板外 1px, 即设计的 outset）; 修复前是 `[15,13,32,30]`.
- 像素扫描（沿面板中线自上而下）: y=249.6 起是光环（chroma 53）,
  y=252.6 起是深色面板（lum 70）, **两者之间没有任何页面背景** ——
  光环确实压在面板边缘上.
- `node --check` 通过, `node test/run.js` 379 条断言全部通过, 版本守卫通过.

## [3.0.8] - 2026-10-04

### 回滚
- **下载光环回滚到 v3.0.3 的实现**（用户反馈「光环甚至修坏了」）. v3.0.5 把光环改成
  CSS 定位的子元素、v3.0.7 又把光带换成旋转渐变, 两次重构在真实页面上效果不如预期.
  现整段恢复 v3.0.3 的代码: 光环回到独立的 `position:fixed` SVG 层, 由 JS
  (`syncRing`) 按面板几何同步, dasharray 按真实周长计算.
  **光环问题仍未解决, 保持打开状态待重新设计.**

### 修复
- **进度条文字折行后被裁切**（用户反馈「进度条文字过长导致变成两行但进度条细了显示错误」）.
  `#dlr-progress` 是固定 `height:22px` + `overflow:hidden`, 而 `.pct` 用
  `height:100%` + `align-items:center` 居中单行. 下载阶段的标签较长
  （`切片 48/57 · 32.5 MB/38.6 MB · 7.2 MB/s · 剩 00:01 · 已暂停`）, 会折成两行,
  文字块高 34px 超出 22px 的框, **下半行被裁掉**（实测 `clippedBy: 14px`）——
  看起来就像「进度条变细了」.
  现改为: `#dlr-progress` 用 `min-height:22px` + `height:auto` 让框随内容长高,
  `.bar` / `.stripes` 用 `inset:0` 自动跟随新高度; `.pct` 改用 `padding` +
  `min-height` 居中（不再依赖 `height:100%`, 多行时末行不会被裁）,
  `line-height:1.35` 让两行时行距不挤, `overflow-wrap:anywhere` 保证长数字串能断行.
  单行时仍是 22px, 观感不变.

### CI
- 上一次提交（v3.0.7 的死代码清理）改了 `.user.js` 却没升 `@version`,
  被 `test/version_guard.sh` 正确拦下, 导致 GitHub Actions 失败. 本次已升到 3.0.8.
  提醒: `node --check` 对孤立的声明块不报错, 版本守卫是唯一能发现「改了但没升版本」
  的那道关, 它失败时先查版本号.

### 验证
- 进度条: 单行标签框高 20px; 两行标签框高自动长到 36px, `clippedBy: -4`
  （有 4px 余量, 不再裁切）. 像素扫描确认两条文字带都在框内, 距框底 175px 余量.
- `node --check` 通过, `node test/run.js` 379 条断言全部通过,
  `bash test/version_guard.sh` 通过.

## [3.0.7] - 2026-10-04

### 修复
- **下载光环的光带改为「旋转渐变」, 不再用 `stroke-dasharray`**（用户要求「使用一切办法修好」）.
  v3.0.5 用 `pathLength="100"` 归一化周长来让 dasharray 变成固定比例, 但这条路本身是错的:
  实测 `<rect>` 的 `pathLength` 不可靠 —— 真实周长 1184px 时, 按 100 单位分布的 dash
  用 `isPointInStroke` 探测**一个点都命不中**. dasharray 的本质缺陷是「亮段:暗段」两个数
  必须与周长相关: 写死则面板一小就占满整圈(看着全亮)、面板一大就几乎不可见; 按周长重算
  则又要 JS 逐帧追几何, 回到 v3.0.2 的老问题.
  旋转渐变没有长度概念: 渐变定义域是元素自身盒子, 旋转的是整个渐变坐标系. 面板无论多大、
  什么比例, 光带宽度与流速都恒定, **完全不碰周长**, 也不需要任何 JS 参与.
  实现: `<linearGradient>` 首尾透明(读作彗星而非彩虹) + `<animateTransform>` 旋转
  `gradientTransform` 3s 循环. CSS 无法动画 `gradientTransform`, 所以必须用 SMIL;
  `prefers-reduced-motion` 下 `animateTransform{display:none}` 关掉.
  SVG 改用 `viewBox="0 0 100 100"` + `preserveAspectRatio="none"`, rect 用百分比几何,
  `stroke-width` 以 viewBox 单位计 —— 面板缩成横条时光带自然变细.

### 并顺清理
- 删掉 v3.0.5 留下的过时注释块与一段孤立的  残留
  ( 对孤立声明块不报错, 所以不能依赖语法检查发现).
  现实测光环元素上不再存在任何 dasharray/dashoffset 属性.

### 验证
- 几何: 光环盒子与面板盒子逐像素相同, 展开 / 更多设置开合 / 收缩成横条 / 拖动 /
  窗口缩放 五类场景错位全为 `[0,0,0,0]`.
- 光带确实在流动: 沿周长取 24 个采样点读色度, 间隔 1s 两次采样有 18/24 个点亮度改变,
  峰值色度 194.
- 视觉复核: 描边贴合面板外边缘(含圆角), 不超出上下边界; 亮度在周长上分布不均
  (右/下较亮、左/上较淡), 符合 traveling band.

## [3.0.6] - 2026-10-04

### 修复
- **空格快捷键从未生效**. 代码比对 `e.key === ''`, 但浏览器给空格的是 `e.key === ' '`
  (含一个空格字符); `'Spacebar'` 是 IE/EdgeHTML 旧值, 三个分支都命不中.
  该快捷键自 v2.4.0 引入起就是死的. 改为按 `' '` 判定.
  (v3.0.5 的提交里这一条因编辑脚本中途断言失败而未写入, 此处补上.)

### 验证
- 浏览器实测: 空格按下即开始下载(按钮禁用 + 光环点亮), 再按切换为「▶ 继续」,
  第三次按恢复「⏸ 暂停」; 下载中按 M 收起面板后光环错位 `[0,0,0,0]`.

## [3.0.5] - 2026-10-04

### 修复
- **下载光环改为由 CSS 决定尺寸, 不再用 JS 追几何**. 这是 v3.0.2/v3.0.3 的结构性收尾:
  之前光环是独立的 `position:fixed` SVG 层, 每帧读面板的 `getBoundingClientRect()` 再回写
  自己的 `width`/`height`/`left`/`top`. 这条链路**在原理上必然漏**——面板尺寸变化的来源有十几种
  (自身 transition、子元素展开、内容换行、窗口缩放、字体加载), JS 只能逐个挂事件去追,
  漏一次就永久错位. v3.0.2 靠 `ResizeObserver` 补住了「尺寸变化」, 但「位置变化」(拖动、缩窗)
  仍要手动同步, 且真实页面上用户仍能复现错位.
  现把光环改为面板的**子元素**(`#dlr-panel` 的直接子节点, 与 `.body` 并列), 尺寸完全交给
  CSS: `position:absolute; width:100%; height:100%`. 浏览器自己保证它与面板同大,
  「追不上」这件事从根上不存在了.
- **SVG 用 `pathLength="100"` 归一化周长**, 于是 `stroke-dasharray` 是纯比例 `28 72`,
  动画 `stroke-dashoffset: 0 → -100` 走完归一化的一圈. 面板怎么变宽变窄, 光带都占 28%,
  不再需要按真实周长重算 dasharray (那正是 v3.0.2 修的 `pathLength` 毛病的同源问题).
  rect 几何也改用 `width="100%" height="100%"` + `rx="3%"`, 圆角随面板自适应.
- 因此 `syncRing()` 及其全部调用点(`progressReset` / `progressSet` / `setMini` / `applyPos` /
  transition 监听 / ResizeObserver)一并删除, 代码少了一整套易错的同步机制.

### 顺带修复(同批审计发现)
- **空格快捷键从未生效**: 代码比对 `e.key === ''`, 但浏览器给空格的是 `e.key === ' '`
  (含一个空格字符); `'Spacebar'` 是 IE/EdgeHTML 旧值. 三个分支都命不中, 该快捷键自 v2.4.0
  引入起就是死的. 现按 `' '` 判定.
- **保存的分辨率每次刷新都被丢弃**: 面板模板里 `<select id="dlr-res">` 只有 `value=""`
  一个选项, 恢复赋值时匹配不到被浏览器静默置空, 随后 `fillResOptions` 读到的已是空值.
  用户设了 720p 却在悄悄下 1080p, 流量翻倍且毫无提示. 改为先记下 GM 值, 等选项建好后再套用.
- **截取时长提示与声明的单位不一致**: `fmtTime()` 固定按 `h:mm:ss` 渲染, 而单位可能是
  `mm:ss`. 改为按用户将要填的同一个 unit 渲染, 且 `mm:ss` 分支保留秒
  (90 秒 → `01:30`, 曾一度写成 `Math.round(dur/60)` 会得到 `2:00`).

### 验证
- 光环盒子与面板盒子**逐像素相同**: 收缩 / 展开 / 更多设置开合 / 拖动 / 窗口缩放 / 高 DPR
  (1.0 / 1.5 / 2.0 / 2.5) 六类场景下错位均为 `[0,0,0,0]`, 不再是 ±1~2px 的容差.
  逐帧采样 22 帧无一帧超过 1px.
- 像素扫描: 光环描边上下缘落在 336.5~339.5 (面板顶边 338.5)、左右缘落在 570.5~573.5
  (左边 572.0), 即描边正好压在面板边缘上; 收起成横条后同样贴合.
- 空格: 按下即开始下载, 再按切换暂停.
- 分辨率: 保存 `1280x720` 后刷新仍选中; 保存本片不存在的 `999x999` 时回落"自动"不崩;
  手动改档后重新预取仍保留用户选择.
- `node test/run.js` 379 条断言全部通过(新增 6 条覆盖时长提示的 unit 一致性), `node --check` 通过.

## [3.0.3] - 2026-10-04

### 修复
- **面板拖到屏幕边缘后缩小窗口, 面板会跑到屏幕外且无法拖回**. 拖过的面板用的是存下来的
  `left`/`top` 定值, 窗口一小就整体移出可视区 —— 实测 1400px 窗口下把面板拖到右缘 (left=1000),
  缩到 760px 后 392px 宽的面板有 240px (61%) 在屏幕外, `elementFromPoint` 在任何可见位置都
  返回不到面板, 鼠标再也抓不住它, 只能刷新页面找回. `clampPanelPos` 本来就有防越界钳制,
  只是缩放后没人再调用它; 现记下钳制后的坐标, 窗口 resize 时重跑一次 `applyPos` 重算.
  记「钳制后」的值而非拖动原始值, 否则每次缩放的误差会逐次累积.

### 验证
- 三类场景: 拖到右缘后缩窗 (修复前 61% 出屏 → 现在 100% 可见且可抓取)、反复缩放
  1100/1400/900/1300/760 位置不累积漂移、未拖动过的面板 (仍走 CSS `right`/`bottom`) 不受影响.
- 光环回归: 收缩 / 展开 / 更多设置开合 / 拖动 四项逐帧采样仍为 0 错位帧, 本次改动无回退.
- `node test/run.js` 373 条断言全部通过, `node --check` 通过.

## [3.0.2] - 2026-10-04

### 修复
- **下载光环不跟随面板变化**（用户反馈的「框出一大块地方 / 不跟着变大」）. 根因是光环靠
  `transitionstart` / `transitionend` 驱动一个 rAF 逐帧循环, 而这两个事件会从**子元素**冒泡到面板:
  收起面板时子元素先结束过渡（如「收起」按钮的 opacity 150ms, 比面板 280ms 短）, 循环被提前停掉,
  面板自己的高度过渡还在跑, 光环从此停在旧尺寸上 —— 实测错位 20~187px 且不会自行恢复.
  现改用 `ResizeObserver` 监听面板盒子, 只要尺寸变了就同步, 与「为什么变」无关; 同时只在
  `e.target === panel` 时才起停 rAF, 忽略冒泡来的子元素事件, 并在过渡结束时补一次同步兜底.
- **拖动面板时光环原地不动**: 拖动只改位置不改尺寸, `ResizeObserver` 不会触发, 补上 `applyPos` 内
  的手动同步; 窗口缩放同理补了 `resize` 监听.
- **光环 `stroke-dasharray` 少一个逗号**: 原来是字符串拼接 `seg + '' + (perim - seg)`, 拼出
  `'533.11370.8'` 这样的非法值, 浏览器只解析出 `533.113`, 于是实际是「533px 实线 + 0.8px 缝」——
  绕一圈几乎全亮, 看不出光带在流动. 改为 `seg + ',' + (perim - seg)`.

### 验证
- 浏览器逐帧采样（rAF 内, 在光环自身 rAF 之后读几何）: 收缩 / 展开 / 更多设置开合 / 拖动 /
  窗口缩放 五种场景下错位帧数 **0**, 稳定后错位 2px（即设计里的 1px 外扩 + 描边半宽）.
- 像素级复核: 光环上下缘分别落在面板上下缘外 1px 处, 与设计值一致.
- `node test/run.js` 373 条断言全部通过, `node --check` 通过.

### 其他
- 顺带修掉脚本里 3 处 U+FFFD 乱码字符（注释内, 由更早的编辑遗留）.

## [3.0.1] - 2026-10-04

### 变更
- **「完成/失败通知」改为默认关闭**(用户要求). 系统通知与提示音现在默认都是关的,
  需要时在「更多设置」里自行打开. 该开关的 `title` 补充了说明.
- 诊断日志里通知开关的显示默认值同步改为「关」, 避免与面板实际状态不一致.

### 文档
- **措辞严谨化**: 去掉夸大与绝对化表述, 改为带条件的准确陈述.
  - 顶部简介加限定: 「免登录」改为「免登录即可下载**公开可访问的**回放」.
  - 使用章节: 「几乎瞬间完成」改为「只需合并保存, 实际耗时取决于预下载完成度」;
    预览一项补上「选择 MP4 且下载成功时」的前提, 并指向已知限制中TS 无法预览的说明.
  - 安装章节: 「此开关默认关闭时, 油猴脚本一行都不会执行」改为「该开关默认关闭, 关闭时脚本不会执行」.
  - 原理章节: 「**绝不能带 Origin 头**」改为「实测带上会返回 403」—— 这是经验结论而非接口契约.
  - 版权提示: 「**绕过 CDN 签名**」改为事实描述 —— 播放地址由接口正常返回并自带约 10 天时效签名,
    脚本既不破解也不篡改签名; 避免把正常接口调用表述成规避访问控制.
## [3.0.0] - 2026-10-04


### 文档
- **README 中英双语**: 中文为默认版直接展开, 英文版收在 `<details>` 折叠块里, 顶部可一键跳转.
  两版章节结构完全对应(7 节), 45 条功能点逐条对齐, 安装链接 / 原理 / 开发 / 限制 / 版权
  均有对应英文.
- **面板文案与 README 统一**: 毛玻璃开关改称「开启毛玻璃效果」, 全角标点统一为英文标点,
  多余空格收紧（涉及面板模板 20 处与运行时文案 171 处; 代码注释保持中文）.
### 修复
- 下载光环: 原先 `pathLength=400` 把光带比例写死, 实际周长被强行归一化, 光带缩成一小段
  甚至不可见. 现按真实周长动态计算 dasharray, 动画偏移用 CSS 变量 `--ring-perim`,
  整周期正好走完一圈; 显隐改内联 opacity; 进度条出现 / 宽度变化、折叠区展开收起等
  **不触发面板自身 transition** 的尺寸变化也会同步光环.
- 「更多设置」展开后空白: 收起态下 `scrollHeight` 恒为 0 导致高度永远写不进去, 且本页面上
  `.open{opacity:1}` 已匹配却仍算出 0. 现高度与 opacity 均由 JS 内联写入, 并给出兜底高度.
- 全局紧凑排版 + 视口自适应: 全部展开时面板 1178px → 约 770px, 且高度上限跟随窗口
  (`100vh - 140px`), 实测 700 / 800 / 1200px 视口均不超出边界.
- 拖拽不再劫持表单控件, 收起成横条后也能拖动, 拖完不会误弹开.
### 新增
- **解析阶段后台预下载**（见 2.7.0）: 打开页面即在后台静默拉片, 点下载只需合并保存.
### 全量代码审计
- 逐项静态扫描 3800+ 行, 修掉 `qGo`/`qClear`/`qInfo` 三处隐式全局变量（逗号续行漏 `const`）
  与 `DL.running` 可能永久停在 true 的问题（`finally` 兜底复位）.
## [2.9.0] - 2026-10-04


全量代码审计: 逐项静态扫描脚本 3800+ 行, 修掉扫描发现的真实缺陷, 并做浏览器回归.

### 修复
- **BUGFIX: `qGo` / `qClear` / `qInfo` 是隐式全局变量**.
  `const qBox = ..., qRow = ...,\n    qGo = ..., qClear = ..., qInfo = ...` —— 逗号续行时
  只有第一项带声明符, 第二行三个变量全部漏了 `const`, 于是挂到 `window` 上污染
  共享作用域(userscript 之间共用同一个全局对象).
- **BUGFIX: 下载异常时 `DL.running` 可能永久停在 true**.
  `run()` 的 `finally` 只恢复按钮, `DL.running` 的复位依赖 `progressDone()`;
  而 `progressDone()` 内有一堆 DOM 操作(进度条 / spinner / 光环), 它自己抛错时
  状态就再也复位不了 —— 之后空格/Esc 快捷键全部失效、「删除已下载」也清不掉缓存,
  面板看起来「死了」. 现在 `finally` 无条件复位运行态与预下载运行态.
- 拖拽 mouseup 与自定义分辨率回退里的 `GM_setValue` 补 try 保护:
  前者抛错会跳过下一行 `suppressExpandClickAt` 赋值, 症状是「拖完面板反而弹开」.
### 审计覆盖
- 空catch 与异常吞噬点(43 处, 逐个确认无害)
- 循环内 await(确认均为必要的串行语义, 非性能问题)
- `innerHTML` 赋值(3 处, 均为清空, 无注入面)
- 未声明全局变量(16 处疑似 → 确认 3 处真实, 已修)
- `DL.running` 状态机的所有置位/复位路径
- `setInterval` / `setTimeout` 泄漏
## [2.7.0] - 2026-10-04


### 新增
- **解析阶段后台预下载**: 打开回放页后, `prep()` 解析出切片列表即在后台静默下载,
  弱并发 2 以免抢用户带宽. 点「下载」时只需合并保存, 等待时间被前置到浏览页面的
  那段时间里. 更多设置新增「解析后后台预下载」开关(默认开).
- 预下载进度写入日志(两行: 开始 / 完成), 不弹提示、不改进度条——后台行为不打扰用户.
- 「中断」与「删除已下载」会一并停掉/清空预下载缓存.
### 技术细节
- **预下载只存内存, 不写 IndexedDB**. 两个原因: ① `partial` 的 key 含截取区间
  (`roomId|liveUuid|res|from-to`), 而预下载发生在用户还没设截取时, 两者 key 必然不同,
  复用等于永远命不中; ② IndexedDB 只有单槽, 预下载去写会与用户正式下载的断点缓存
  抢槽, 用户点「删除已下载」时就得连带清理. 只放内存则语义清晰, 刷新即丢弃.
- **带截取区间时不复用预下载**: 预下载下的是完整回放的切片, 按区间裁剪后切片下标
  对不上, 强行复用会拿到错位的片段. 只在 `!clip.range` 时整段命中.
- 正式下载一开始就把 `pre.stop` 置 true, 避免两边同时拉同一片.
## [2.6.3] - 2026-10-04


### 变更
- **面板文案统一为英文标点**(用户要求): 全角 `：，。（）；、` 全部换成
  `: , . ( ); ,`, `「」` 换成双引号, `…` 换成 `...`; 装饰性间隔符 `·` 换成 `|`,
  去掉标点后多余的空格. 涉及面板模板 20 处与运行时文案 171 处(日志/状态栏/报错/
  tooltip), **代码注释保持中文不变**.
- **「毛玻璃」改为「开启毛玻璃效果」**, 与其它开关的动词开头写法一致.
### 修复
- 文案统一时若连带 `strip()` 字面量, 会把日志刻意的前导缩进(对齐用)一起删掉;
  实测已保住 `appendLog('   标题: ')` 这类缩进, 只清理尾部空格.
- 队列解析的错误断言改为正则 `/第\s*2\s*行/` + `/格式不对/`, 只验语义不绑死空格.
## [2.6.2] - 2026-10-04


### 修复
- **BUGFIX(用户实测): 下载光环不可见 / 只剩一小截**.
  根因是 `pathLength=400` + `stroke-dasharray: 110 290` 的组合: pathLength 会把
  实际周长(本例 2722px)强行归一化成 400, dasharray 的比例随之失真, 光带缩成
  极短的一段. 现在按真实周长动态计算 dasharray(亮段占 28%), 动画偏移改用 CSS
  变量 `--ring-perim`, 整周期正好走完一圈.
- **BUGFIX: 光环显隐不可靠**. `.on{opacity:1}` 在本页面上已匹配却仍算出 0
  (与 .more-body 同一个坑), 改为内联 opacity.
- **BUGFIX: 光环与面板错位**. 原来只在面板自身 transitionstart/end 时同步,
  而进度条出现/宽度变化、折叠区展开收起并不触发面板 transition. 现在
  `progressReset` / `progressSet` 都会调 `syncRing`, 并监听进度条自身的
  `transitionend`(transitionend 不冒泡, 只能直接绑元素)补一次同步.
## [2.6.1] - 2026-10-04


### 新增
- **面板视口自适应**:面板高度上限跟随窗口可用高度(`calc(100vh - 140px)`),
  超出部分在面板内滚动并配了细滚动条. 实测 700/800/1200px 三种视口下面板均不超出边界.
- **全局紧凑排版**:区块间距 8→5px、行间距 6→3px、输入框与下拉 34→26px、
  提示文字 11→10.5px. 全部展开时面板从 1178px 降到约 770px(约 -35%).
### 修复
- **BUGFIX(用户实测): 打开「更多设置」看不到任何东西**.
  两个叠加原因: ① 折叠区在收起态(`height:0`+`overflow:hidden`)下 `scrollHeight`
  恒为 0, 于是 `if (h > 0)` 永远不成立、高度永远写不进去; ② 实测该页面上
  `.open{opacity:1}` 虽已匹配却仍算出 0, class 规则不可靠.
  现在高度与 **opacity 都由 JS 写内联**(内联优先级最高, 不依赖样式表计算),
  并给一个兜底高度保证点开瞬间就有内容, 再异步实测修正.
- **BUGFIX: 展开后下方元素错位**. 曾给 `.open` 加 `height:auto` 兜底, 与收起态的
  `height:0` 语义冲突, 把页脚等元素顶到错误位置. 展开态只改透明度, 高度一律内联.
- **样式注入双保险**: `GM_addStyle` 改为「优先调用、失败或未生效则退回原生<style>」,
  避免沙箱内偶发失效导致整段样式丢失且无任何报错.
- **实测修正改用 `setTimeout(…,0)`**: `requestAnimationFrame` 在页面不可见时被节流,
  不保证执行, 会让展开动画停在兜底高度上.
### 技术细节
- 收起/展开动画统一用**内联 height + opacity 过渡**: 实测本页面上 class 规则会被
  压过(连 `!important` 都输), 内联优先级最高, 不依赖任何 CSS 特异性计算.
## [2.6.0] - 2026-10-04


### 新增
- **收起成横条后也能拖动**:此前拖拽把手只在展开态的标题区, 收起后仅剩的横条没有
  拖拽能力, 面板收起后完全无法移动.
- **拖动时自动收起设置**(更多设置里可关, 默认开):拖动面板时折叠「更多设置」与输出
  预览区, 拖完恢复原状态.
- **更多设置紧凑排版**:数字框与下拉框两两并排, 八个开关排成两列网格.
- **收起/展开动画同步**:横条改用与面板主体同一条曲线, 不再「啪」地闪出.
- **输出框展开/收起动画**:此前是 `display:none` 硬切换, 无过渡.
### 修复
- **BUGFIX(用户实测报告): 拖拽劫持表单控件**. 2.4.0 把 `.drag` 绑在 `.bin` 上, 而它
  包住了整个表单(链接框/文件名/格式/分辨率/截取/更多设置), `mousedown` 里又调了
  `preventDefault()` —— 区域内所有输入框和下拉框都收不到焦点, 整个面板「只能看不能改」.
  现在只有按在空白处才启动拖拽, 落在控件上完全不管.
- **BUGFIX: `id="dlr-retry"` 被两个元素复用**——「只重试失败切片」按钮与「重试次数」
  输入框共用同一个 id, `getElementById` 返回文档里第一个(按钮), 导致重试次数输入框
  永远拿不到、无法调节. 输入框改名 `dlr-retry-num`. 面板内 46 个 id 现已全部唯一.
- **BUGFIX: 收起态完全无法拖动**. 控件排除表里写了 `.expand`, 而它本身就是收起态的
  拖拽把手, 把自己排除了.
- **BUGFIX: 拖完面板会被弹开**. 拖拽后紧跟的 click 触发了「点击展开」. 改用时间戳判定
  (原先用标志位 + `setTimeout(...,0)` 清除, 而 click 在同一轮事件循环更早派发, 标志被提前清掉).
- **折叠区展开高度写不进去**:收起态下容器 `height:0`+`overflow:hidden`, `scrollHeight`
  恒为 0, 于是永远量不到内容高度. 改为量高前先临时解除高度约束, 量完恢复.
### 技术细节
- 折叠区统一用**内联 height + opacity 过渡**, 不靠 CSS 的 `max-height`/`grid-template-rows`:
  钉钉页面自身的样式表顺序会让展开值被收起值压住(实测 computed 高度恒为 0),
  内联优先级最高, 不依赖任何 CSS 特异性计算.
## [2.5.0] - 2026-10-04


### 新增
- **帧级精确截取的入口指引**:截取区提示行里加蓝色链接「点这里打开『帧级精确截取』」,
  点击自动展开「更多设置」并让该开关闪两下, 不用用户自己在更多设置里翻找.
- 开关标题改为「帧级精确截取（实验性 · 默认关）」并补充 title 说明:
  默认关闭, 开启后要先下载完整回放再裁剪, 流量更多.
### 修复
- 提示行的更新逻辑用 `textContent =` 整体覆写, 会把里面的跳转链接一起替换掉——
  链接在启动时就被无声抹掉. 改为「纯文本节点 + 独立链接节点 + 文本尾巴」三段拼接.
- 跳转链接改为**事件委托**绑在提示行容器上: 链接由提示更新函数在运行时生成
  (晚于绑定代码执行), 直接 `getElementById` 此刻拿到 null, 绑定会静默失效.
### 技术细节
- 帧级精确截取**仍默认关闭**(用户 2026-10-04 决定): 切片边界对齐已能满足多数需求,
  帧级精修要先下完整回放, 流量代价大, 交给用户按需开启——但必须让他知道在哪开.
## [2.4.0] - 2026-10-04

### 新增
- **面板可拖拽**:按住标题区即可拖动, 位置写入 `GM_setValue('dlr_pos')`, 刷新后恢复.
- **键盘快捷键**:`空格` 开始下载/下载中暂停继续, `Esc` 下载中中断、空闲时收起展开,
  `M` 切换收起. 输入框/textarea/可编辑区内一律不拦截, 打字不会被抢键.
### 技术细节
- 拖拽钳制**刻意不对称**:只夹 x 不夹 y. 面板展开后常比视口还高(实测 658px vs 视口 566px),
  若把 y 也夹进视口, 面板就永远贴在顶部、用户会以为「拖不动」. 横向必须夹住, 否则面板
  会整个消失到屏幕外、找不回来.
- 拖动中给面板加 `.dragging` 临时关掉 transition——否则 width/left 一起做动画会粘滞.
- 快捷键用 `DL.running` 判断状态, 不看按钮显隐: 面板收起时控制条不可见但下载确实在跑,
  只看显隐会让空格在收起状态下误触发「开始下载」.
- 把手用 `user-select:none` + `touch-action:none`, 前者防拖动时选中标题文字, 后者让
  触屏也能拖而不是触发页面滚动.
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
[3.5.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.4.0...v3.5.0
[3.5.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.5.0...v3.5.1
[3.5.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.5.1...v3.5.2
[3.6.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.6.0...v3.6.1
[3.6.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.5.3...v3.6.0
[3.5.3]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.5.2...v3.5.3
[未发布]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.6.1...HEAD
[3.3.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.2.1...v3.3.0
[3.4.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.3.1...v3.4.0
[3.3.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.3.0...v3.3.1
[3.2.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.9...v3.1.0
[3.0.9]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.8...v3.0.9
[3.0.8]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.7...v3.0.8
[3.0.7]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.6...v3.0.7
[3.0.6]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.5...v3.0.6
[3.0.5]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.3...v3.0.5
[3.0.3]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.9.0...v3.0.0
[2.9.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.7.0...v2.9.0
[2.7.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.6.3...v2.7.0
[2.6.3]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.6.2...v2.6.3
[2.6.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.12...v2.0.0
[1.9.12]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.11...v1.9.12
[1.9.11]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.10...v1.9.11
[1.9.10]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.9...v1.9.10
[1.9.9]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.8...v1.9.9
[1.9.8]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.7...v1.9.8
[1.9.7]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.6...v1.9.7
[1.9.6]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.5...v1.9.6
[1.9.5]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.4...v1.9.5
[1.9.4]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.9...v1.7.0
[1.6.9]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.8...v1.6.9
[1.6.8]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.7...v1.6.8
[1.6.7]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.6...v1.6.7
[1.6.6]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.5...v1.6.6
[1.6.5]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.4...v1.6.5
[1.6.4]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.2...v1.6.4
[1.6.2]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.4.0...v1.6.0
[1.4.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Vectg/dingtalk-live-replay-downloader/compare/4bbb374...v1.2.0
