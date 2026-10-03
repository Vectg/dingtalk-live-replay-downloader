# dingtalk-live-replay-downloader

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-blue)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> A Tampermonkey userscript to download DingTalk live replays (no login) — outputs `.ts` or `.mp4`.

通过公开接口获取钉钉直播**回放**的 m3u8 播放列表，下载全部 TS 切片并拼接成一个文件。
**无需登录钉钉账号**，在直播回放页面上点一下即可。

> 中文说明见下文；English summary above. 只用于下载你**有权留存**的内容。

可配置：

- **输出格式**：`.ts`（原始拼接，最稳，VLC/mpv/PotPlayer 播放）或 `.mp4`（用 `mux.js` 在浏览器内转封装，实验性；转封装失败会自动回退为 `.ts`）
- **并发线程**：同时下载切片的数量（1–16，默认 5）
- **重试次数**：单个切片下载失败时的重试次数（1–10，默认 3）

---

## 安装

1. 安装 [Tampermonkey（油猴）](https://www.tampermonkey.net/) 浏览器扩展。
2. 打开本脚本的 **Raw 地址**（复制 GitHub 页面右上角 `Raw` 按钮的链接），Tampermonkey 会提示安装；或「新建脚本 → 粘贴内容」。
3. 安装后，打开任意钉钉直播**回放**页（URL 形如 `n.dingtalk.com/dingding/live-room/index.html?roomId=...&liveUuid=...`）。

## 使用

1. 打开目标直播回放页。
2. 页面右下角出现「钉钉直播回放下载」面板，会自动读出本页的 `roomId` / `liveUuid`。
3. 选择**输出格式**、**并发线程**、**重试次数**。
4. 点「下载本页回放」，面板会显示进度：取 token → 拿播放地址 → 拉 m3u8 → 下载切片 → 拼接 → 保存。
5. 完成后弹出保存对话框，保存为 `<标题>.ts` 或 `<标题>.mp4`。

也可以把任意回放链接粘贴进面板输入框再点下载（不必停留在该页）。

---

## 原理

- `GET https://lv.dingtalk.com/csrf`（**不带 Origin 头**）拿到 CSRF token，并得到 `XSRF-TOKEN` cookie。
- `POST https://lv.dingtalk.com/getOpenLiveInfoV2`（**单对象 body**，同时带 `XSRF-TOKEN` cookie 与 `X-XSRF-TOKEN` 头）→ 返回 `openLiveDetailModel.playbackUrl`（带签名的 m3u8，有效期约 10 天）。
- 拉取 m3u8，解析其中的 `.ts` 切片 URL（每片带各自签名）。
- 并发下载全部切片，按顺序字节拼接成单个 `.ts`。

关键点：`getOpenLiveInfo`（V1）的 `playbackUrl` 对匿名用户是**空字符串**，必须用 V2；`sliceCount`/`sliceDuration` 是雪碧图参数，**不是**切片数，切片数以 m3u8 实际条目为准。

---

## 转成 MP4（可选）

脚本已内置 **MP4 转封装**（`mux.js`，`@require` 加载，在浏览器内完成，无需额外工具）。若你更习惯用 ffmpeg，也可把 `.ts` 交给它重封装：

```bash
# 先建 concat 列表（按数字升序）
for i in $(seq 1 <N>); do echo "file 'ts/$i.ts'"; done > concat.txt
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy -bsf:a aac_adtstoasc out.mp4
```

Windows 下若遇到带引号/中文文件名的路径问题，用 Python `subprocess.run([...])` 传参。

---

## 注意事项

- **版权与条款**：脚本通过公开接口抓取回放。请仅下载自己有权留存的内容，勿传播或用于商业用途。
- 回放签名约 10 天有效，过期后重新跑一次即可（每次调用会拿到全新签名）。
- 需要 `@connect` 权限：除脚本自带的 `lv.dingtalk.com` 与 `dtliving-sz.dingtalk.com` 之外，若在非标准镜像域名上运行，请自行补充。
- 已授权最小权限：`GM_xmlhttpRequest`（跨域请求）、`GM_download`（保存文件）、`GM_addStyle`（面板样式）。

---

## License

[MIT](LICENSE)
