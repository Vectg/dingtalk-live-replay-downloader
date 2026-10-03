# dingtalk-live-replay-downloader

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-blue)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A Tampermonkey userscript that downloads DingTalk live replays **without logging in** — fetches the replay m3u8 playlist through public APIs, downloads every segment in the browser and assembles one file.

通过公开接口获取钉钉直播**回放**的 m3u8 播放列表，浏览器内下载全部切片并拼成一个文件。**无需登录钉钉账号**，在回放页点一下即可。

> Only download content **you have the right to keep**. 仅用于下载你有权留存的内容。

---

## 功能（v1.6.1）

**核心**

- **无需登录**：`csrf` → `getOpenLiveInfoV2` 取带签名的播放地址，全程匿名。
- **输出 MP4（默认）/ TS**：`.mp4` 由 `mux.js` 在浏览器内转封装；`.ts` 为原始拼接，兼容性最好。
- **MP4 时长与进度条已修复**：`mux.js` 输出的 `moov/mvhd/mdhd` duration 写成 `0xFFFFFFFF`（unknown 哨兵），播放器会显示成十几小时、拖不动进度条、画面卡死。脚本遍历 `moof` 用 `tfdt + Σtrun` 算出真实时长写回，30 分钟回放即显示 30 分钟，文件大小不变。
- **失败诊断**：切片失败给出序号 + URL + 原因，并按错误类型给排查建议（401/403 签名过期、404 回放已清理、其他降并发/更新脚本）。
- **进度动画**：进度条 + 分段日志，实时显示 `n/N` 与 MB/s。

**下载后处理**

- **截取时长**：只下载「开始 → 结束」区间内的切片，留空即整段；按切片边界对齐（约 30 秒粒度）。
- **内置预览**：MP4 下载完成后可在面板内直接播放，支持**倍速**（0.5×–2×）与**音量**控制。
- **记住保存路径** / **文件名加时间戳**。

**面板外观**

- **毛玻璃**：默认开启。面板为半透明 + 背景模糊（`backdrop-filter`），可透出底层播放器画面；不想模糊就取消勾选「毛玻璃」，状态用 `GM_setValue` 持久化，刷新后保留。
- **深色主题**：面板、输入框、按钮均为深色，暗光环境下不刺眼。

**协议兼容**

- **多码率**：遇 `#EXT-X-STREAM-INF` 自动选最高带宽递归。
- **AES-128**：遇 `#EXT-X-KEY` 用 Web Crypto 拉 key 逐片解密。
- **fMP4 / BYTERANGE**：支持 `#EXT-X-MAP` 初始化段与 `#EXT-X-BYTERANGE` 字节范围。
- **并发**（1–16，默认 5）与**重试**（1–10，默认 3，指数退避）。

---

## 安装

1. 安装 [Tampermonkey（油猴）](https://www.tampermonkey.net/)。
2. 打开下面的 Raw 地址即可触发安装页：

   ```
   https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
   ```

   脚本带 `@updateURL` / `@downloadURL`，**装过一次后可直接在油猴里「检查更新」自动升级**。

3. 在 Edge / Chrome 还需到 `edge://extensions/`（或 `chrome://extensions/`）→ 篡改猴 → 详细信息，打开 **「允许用户脚本」**。此开关默认关闭时，油猴脚本一行都不会执行，右下角不会出现面板。

> 面板不出现时：确认开关已开 → 油猴里脚本为启用状态 → 回放页 `Ctrl+F5` 强刷 → F12 Console 看报错。

---

## 使用

1. 打开回放页（`n.dingtalk.com/dingding/live-room/index.html?roomId=...&liveUuid=...`），右下角出现面板并自动读出链接。
2. 按需设置：**输出格式**、**截取时长**（`mm:ss` 或 `hh:mm:ss`，留空为全部）、并发、重试；想要面板透出底层画面就勾**「毛玻璃」**。
3. 点「下载本页回放」，进度条依次显示：取 token → 播放地址 → m3u8 → 切片 `n/N` → 拼接 → 保存。
4. MP4 下载完成后面板内直接出现**预览播放器**，可调倍速与音量；同时弹出保存对话框。
5. 也可把任意回放链接粘贴进输入框再点下载，不必停留在该页。

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

## 已知限制

- 截取按切片边界对齐（约 30 秒粒度），非帧级精确。
- 预览的**倍速/音量只作用于面板内播放**，不改变已保存的文件——改写音频音量或播放速度需重新编码，浏览器内无法可靠完成；需要这类处理请把 `.ts` 交给 ffmpeg。
- `.ts` 无法在浏览器 `<video>` 内预览（Chromium 不解码 MPEG-TS），需 VLC / mpv / PotPlayer，或改选 MP4。
- 回放签名约 10 天有效，过期后重新点一次下载即可。
- 已授权 `@connect *`：HLS CDN 域名随回放变化（`dtliving-sz.dingtalk.com`、`dtlive-sz.dingtalk.com` 等），故放开为任意域名；介意可改成具体域名自行补充。
- 权限仅 `GM_xmlhttpRequest`（跨域请求）、`GM_download`（保存文件）、`GM_addStyle`（面板样式）、`GM_getValue`/`GM_setValue`（记住毛玻璃开关）；脚本只读当前页 URL 的 query 参数，不读取、不上传任何页面内容。

---

## 版权提示

脚本通过公开接口获取回放，**绕过 CDN 签名**。钉钉《用户协议》可能将「规避访问控制」列为违约，回放内容本身可能受版权保护。仅用于下载**你自己有权留存**的内容，请勿传播或用于商业用途。

---

## License

[MIT](LICENSE)
