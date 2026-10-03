// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      1.4.0
// @description  通过公开接口获取钉钉直播回放 m3u8，下载全部切片，支持 TS 拼接 / MP4 转封装、多码率 m3u8、AES-128 解密、fMP4(init+分片)、失败诊断、并发数与重试次数。无需登录。
// @author       agent
// @license      MIT
// @match        https://n.dingtalk.com/dingding/live-room/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      *
// @connect      lv.dingtalk.com
// @connect      dtliving-sz.dingtalk.com
// @connect      dtlive-sz.dingtalk.com
// @updateURL    https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
// @downloadURL  https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
// @homepageURL  https://github.com/Vectg/dingtalk-live-replay-downloader
// @supportURL   https://github.com/Vectg/dingtalk-live-replay-downloader/issues
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 常量 ----------
    const CSRF_URL = 'https://lv.dingtalk.com/csrf';
    const INFO_URL = 'https://lv.dingtalk.com/getOpenLiveInfoV2';
    const REFERER = 'https://n.dingtalk.com/';
    const MUX_URL = 'https://cdn.jsdelivr.net/npm/mux.js@6.0.1/dist/mux.min.js';

    // ---------- 日志：面板挂载前的日志先缓存，避免静默丢失 ----------
    const logBuffer = [];
    let statusEl = null;

    function appendLog(msg) {
        if (!statusEl) {
            logBuffer.push(String(msg));
            if (logBuffer.length > 200) logBuffer.shift();
            return;
        }
        statusEl.textContent += '\n' + String(msg);
        statusEl.scrollTop = statusEl.scrollHeight;
    }

    function setStatus(msg, isErr) {
        const safe = String(msg).replace(/</g, '&lt;');
        if (!statusEl) {
            logBuffer.length = 0;
            logBuffer.push(isErr ? safe + '（面板未挂载）' : safe);
            return;
        }
        statusEl.innerHTML = isErr ? '<span class="err">' + safe + '</span>' : safe;
    }

    // ---------- GM 请求封装 ----------
    function gmx(opt) {
        return new Promise((resolve, reject) => {
            const params = {
                method: opt.method || 'GET',
                url: opt.url,
                referer: opt.referer || REFERER,
                timeout: opt.timeout || 120000,
                anonymous: false,
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) resolve(r);
                    else reject(new Error('HTTP ' + r.status + ' ' + (r.response || '').toString().slice(0, 200)));
                },
                onerror: (e) => reject(new Error('网络错误 ' + (e.error || ''))),
                ontimeout: () => reject(new Error('请求超时')),
            };
            if (opt.cookie) params.cookie = opt.cookie;
            if (opt.headers) params.headers = opt.headers;
            if (opt.data) params.data = opt.data;
            if (opt.binary) params.responseType = 'arraybuffer';
            else params.responseType = 'text';
            GM_xmlhttpRequest(params);
        });
    }

    async function getText(url, cookie, headers) {
        const r = await gmx({ url, cookie, headers, binary: false });
        return r.response;
    }
    async function getBinary(url, cookie, headers) {
        const r = await gmx({ url, cookie, headers, binary: true });
        return new Uint8Array(r.response);
    }

    // ---------- 核心 API ----------
    // 重要：GET /csrf 绝不能带 Origin 头，否则 lv.dingtalk.com 返回 403 Invalid CORS request。
    async function getCsrf() {
        const r = await gmx({ method: 'GET', url: CSRF_URL });
        return JSON.parse(r.response).token;
    }

    // POST V2 必须同时带 XSRF-TOKEN cookie 与 X-XSRF-TOKEN 头（两者值均为同一 token）。
    async function getPlayback(roomId, liveUuid, csrfToken) {
        const body = JSON.stringify({ roomId, liveUuid });
        const r = await gmx({
            method: 'POST',
            url: INFO_URL,
            cookie: 'XSRF-TOKEN=' + csrfToken,
            headers: {
                'X-XSRF-TOKEN': csrfToken,
                'Content-Type': 'application/json',
            },
            data: body,
        });
        const j = JSON.parse(r.response);
        const m = j.openLiveDetailModel || {};
        if (!m.playbackUrl) throw new Error('playbackUrl 为空：code=' + (j.code || '') + ' status=' + (m.status || ''));
        return m;
    }

    // ---------- 工具 ----------
    function sanitize(name) {
        let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
        if (s.length > 120) s = s.slice(0, 120);
        return s || 'replay';
    }

    function stamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    // 勾选「记住保存路径」后，第一次弹框，之后静默存到默认下载目录
    let saveAsDone = false;
    function downloadBlob(blob, filename, rememberPath) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            let fellBack = false;
            function cleanup() { setTimeout(() => URL.revokeObjectURL(url), 15000); }
            function anchorFallback() {
                const a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click(); a.remove();
                cleanup();
                setTimeout(resolve, 300);
            }
            const wantDialog = !(rememberPath && saveAsDone);
            try {
                GM_download({
                    url, name: filename, saveAs: wantDialog,
                    onload: () => { saveAsDone = true; cleanup(); resolve(); },
                    onerror: (e) => {
                        if (!fellBack) { fellBack = true; anchorFallback(); }
                        else reject(new Error('保存失败 ' + (e && e.error ? e.error : '')));
                    },
                    ontimeout: () => {
                        if (!fellBack) { fellBack = true; anchorFallback(); }
                        else reject(new Error('保存超时'));
                    },
                });
            } catch (e) {
                anchorFallback();
            }
        });
    }

    // ---------- mux.js 懒加载（不再 @require，避免启动依赖外部 CDN） ----------
    // 油猴沙箱里 window 是代理对象，UMD 挂的全局不一定能从 window 取到，
    // 所以查多个位置，并在 Function 尾部显式 return。
    function pickMux() {
        const cands = [];
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.muxjs) cands.push(unsafeWindow.muxjs); } catch (e) { }
        try { if (window.muxjs) cands.push(window.muxjs); } catch (e) { }
        try { if (typeof muxjs !== 'undefined') cands.push(muxjs); } catch (e) { }
        return cands.find((c) => c && c.mp4) || null;
    }

    let muxGlobal = null;
    async function loadMux() {
        if (muxGlobal) return muxGlobal;
        const existing = pickMux();
        if (existing) { muxGlobal = existing; return muxGlobal; }
        const src = await getText(MUX_URL, '');
        let ret = null;
        try {
            ret = new Function(src + '\n;return typeof muxjs !== "undefined" ? muxjs : undefined;')();
        } catch (e) {
            throw new Error('mux.js 执行失败（可能被页面 CSP 拦截）: ' + e.message);
        }
        muxGlobal = ret || pickMux();
        if (!muxGlobal || !muxGlobal.mp4) throw new Error('mux.js 加载失败（未取得 mp4.Transmuxer）');
        return muxGlobal;
    }
    async function remuxToMp4(tsArray) {
        const mux = await loadMux();
        const transmuxer = new mux.mp4.Transmuxer();
        let init = null;
        const frags = [];
        transmuxer.on('data', (segment) => {
            if (!init) init = segment.initSegment;
            frags.push(new Uint8Array(segment.data));
        });
        for (const ts of tsArray) {
            transmuxer.push(new Uint8Array(ts));
            transmuxer.flush();
        }
        if (!init || !frags.length) throw new Error('mux.js 转封装无输出');
        return new Blob([init, ...frags], { type: 'video/mp4' });
    }

    // ---------- m3u8 解析（master/多码率 + AES-128 + fMP4/MAP + BYTERANGE） ----------
    function resolveUrl(base, v) {
        if (!v) return '';
        try { return new URL(v, base).href; } catch (e) { return v; }
    }

    function parseAttributes(attrText) {
        const out = Object.create(null);
        const re = /([a-zA-Z0-9-]+)=("[^"]*"|[^,]*)/g;
        let m;
        while ((m = re.exec(attrText)) !== null) {
            out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
        }
        return out;
    }

    async function fetchAndParseM3u8(url, depth = 0) {
        if (depth > 5) throw new Error('m3u8 嵌套层级过多');
        const text = await getText(url, '');
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

        const variants = [];
        const segments = [];
        let currentKey = null;
        let currentMap = null;        // #EXT-X-MAP 初始化段（fMP4）
        let pending = null;
        let pendingRange = null;     // #EXT-X-BYTERANGE
        let mediaSequence = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSequence = parseInt(line.split(':')[1], 10) || 0;
                continue;
            }
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
                pending = parseInt(attrs.BANDWIDTH || '0', 10) || 0;
                continue;
            }
            if (line.startsWith('#EXT-X-MAP:')) {
                const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
                currentMap = attrs.URI
                    ? { url: resolveUrl(url, attrs.URI), byterange: attrs.BYTERANGE || '' }
                    : null;
                continue;
            }
            if (line.startsWith('#EXT-X-BYTERANGE:')) {
                const raw = line.slice('#EXT-X-BYTERANGE:'.length);
                const at = raw.indexOf('@');
                pendingRange = {
                    length: parseInt(at >= 0 ? raw.slice(0, at) : raw, 10) || 0,
                    offset: at >= 0 ? (parseInt(raw.slice(at + 1), 10) || 0) : null,
                };
                continue;
            }
            if (line.startsWith('#EXT-X-KEY:')) {
                const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
                const method = String(attrs.METHOD || 'NONE').toUpperCase();
                if (method === 'NONE') currentKey = null;
                else currentKey = { method, uri: resolveUrl(url, attrs.URI || ''), iv: attrs.IV || '' };
                continue;
            }
            if (!line.startsWith('#')) {
                const u = resolveUrl(url, line);
                if (pending !== null) {
                    variants.push({ url: u, bandwidth: pending });
                    pending = null;
                } else {
                    segments.push({
                        url: u,
                        sequence: mediaSequence + segments.length,
                        key: currentKey ? { ...currentKey } : null,
                        map: currentMap ? { ...currentMap } : null,
                        byterange: pendingRange,
                    });
                    pendingRange = null;
                }
            }
        }

        if (variants.length) {
            variants.sort((a, b) => b.bandwidth - a.bandwidth);
            appendLog('   多码率，选择最高带宽 ' + variants[0].bandwidth + ' bps');
            return fetchAndParseM3u8(variants[0].url, depth + 1);
        }
        if (!segments.length) throw new Error('m3u8 无切片');

        // fMP4 判定：有 #EXT-X-MAP，或切片后缀是 .m4s/.mp4
        const withMap = segments.find((s) => s.map);
        const looksFmp4 = !!withMap ||
            segments.some((s) => /\.(m4s|mp4)(\?|$)/i.test(s.url));
        const encrypted = segments.some((s) => s.key && s.key.method === 'AES-128');

        return {
            playlistUrl: url,
            segments,
            encrypted,
            fmp4: looksFmp4,
            initSegment: withMap ? withMap.map : null,
        };
    }

    // ---------- AES-128 分片解密 ----------
    function hexToBytes(v) {
        const hex = String(v || '').replace(/^0x/i, '').replace(/\s/g, '');
        const out = new Uint8Array(Math.ceil(hex.length / 2));
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
        return out;
    }
    function seqIv(seq) {
        const iv = new Uint8Array(16);
        new DataView(iv.buffer).setUint32(12, seq >>> 0, false);
        return iv;
    }
    function keyIv(iv, seq) {
        if (!iv) return seqIv(seq);
        const b = hexToBytes(iv);
        return b.length === 16 ? b : seqIv(seq);
    }
    async function getKeyBytes(key, cache) {
        if (cache.has(key.uri)) return cache.get(key.uri);
        const raw = await getBinary(key.uri, '');
        cache.set(key.uri, raw);
        return raw;
    }
    async function aesDecrypt(buffer, keyBytes, iv) {
        const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buffer);
        return new Uint8Array(dec);
    }
    async function downloadSegment(seg, keyCache, prevEnd) {
        // #EXT-X-BYTERANGE：同一 URL 分段拉取，用 Range 头指定字节区间
        let headers = null;
        if (seg.byterange) {
            const start = seg.byterange.offset === null ? (prevEnd || 0) : seg.byterange.offset;
            const end = start + seg.byterange.length - 1;
            headers = { Range: 'bytes=' + start + '-' + end };
        }
        const r = await gmx({ url: seg.url, headers, binary: true });
        let bytes = new Uint8Array(r.response);
        const consumedEnd = seg.byterange
            ? (seg.byterange.offset === null ? (prevEnd || 0) : seg.byterange.offset) + seg.byterange.length
            : null;

        if (seg.key && seg.key.method === 'AES-128') {
            const keyBytes = await getKeyBytes(seg.key, keyCache);
            bytes = await aesDecrypt(bytes, keyBytes, keyIv(seg.key.iv, seg.sequence));
        } else if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
            throw new Error('不支持的 HLS 加密方式: ' + seg.key.method);
        }
        return { bytes, end: consumedEnd };
    }

    // ---------- UI ----------
    GM_addStyle(`
        #dlr-panel{position:fixed;right:16px;bottom:16px;z-index:999999;width:380px;background:#fff;
            border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.5 system-ui;
            color:#222;padding:14px}
        #dlr-panel h3{margin:0 0 8px;font-size:14px}
        #dlr-panel .row{margin:6px 0}
        #dlr-panel input[type=text]{width:100%;box-sizing:border-box;padding:5px;border:1px solid #ccc;border-radius:4px}
        #dlr-panel input[type=number]{width:64px;padding:4px;border:1px solid #ccc;border-radius:4px}
        #dlr-panel select{padding:4px;border:1px solid #ccc;border-radius:4px}
        #dlr-panel label{display:inline-block;min-width:80px}
        #dlr-panel button{background:#1677ff;color:#fff;border:0;border-radius:4px;padding:6px 12px;cursor:pointer;margin:6px 4px 0 0}
        #dlr-panel button:disabled{background:#aaa;cursor:not-allowed}
        #dlr-panel .chk{display:inline-flex;align-items:center;gap:4px;min-width:auto;font-size:12px;cursor:pointer}
        #dlr-panel .chk input{margin:0}
        #dlr-status{margin-top:8px;padding:6px;background:#f6f6f6;border-radius:4px;white-space:pre-wrap;max-height:180px;overflow:auto}
        #dlr-panel .err{color:#c00}
    `);

    const $ = (id) => document.getElementById(id);

    const panel = document.createElement('div');
    panel.id = 'dlr-panel';
    panel.innerHTML = `
        <h3>钉钉直播回放下载</h3>
        <div class="row"><input type="text" id="dlr-url" placeholder="粘贴链接或自动读取本页"></div>
        <div class="row">
            <label>格式</label>
            <select id="dlr-fmt">
                <option value="ts">.ts（原始拼接，最稳）</option>
                <option value="mp4">.mp4（mux.js 转封装，实验性）</option>
            </select>
        </div>
        <div class="row">
            <label>并发线程</label>
            <input type="number" id="dlr-thread" min="1" max="16" value="5">
            <label style="min-width:60px">重试</label>
            <input type="number" id="dlr-retry" min="1" max="10" value="3">
        </div>
        <div class="row">
            <label class="chk"><input type="checkbox" id="dlr-remember">记住保存路径</label>
            <label class="chk"><input type="checkbox" id="dlr-stamp">文件名加时间戳</label>
        </div>
        <div class="row"><button id="dlr-go">下载本页回放</button></div>
        <div id="dlr-status">就绪。</div>
    `;

    function parseUrl(url) {
        let u;
        try { u = new URL(url.trim()); }
        catch (e) { u = new URL('https://x/?' + url.trim()); }
        const roomId = u.searchParams.get('roomId') || '';
        const liveUuid = u.searchParams.get('liveUuid') || '';
        if (!roomId || !liveUuid) throw new Error('链接缺少 roomId/liveUuid');
        return { roomId, liveUuid };
    }

    // ---------- 主流程 ----------
    async function run(roomId, liveUuid, opts) {
        const goBtn = $('dlr-go');
        goBtn.disabled = true;
        try {
            const token = await getCsrf();
            appendLog('① CSRF token (' + token.slice(0, 8) + '...)');

            appendLog('② 获取播放地址 getOpenLiveInfoV2 ...');
            const model = await getPlayback(roomId, liveUuid, token);
            const baseName = sanitize(model.title || liveUuid);
            appendLog('   标题: ' + model.title +
                '  时长: ' + (model.playbackDuration ? (model.playbackDuration / 1000).toFixed(1) + 's' : '未知'));

            appendLog('③ 拉取 m3u8 ...');
            const parsed = await fetchAndParseM3u8(model.playbackUrl);
            const segs = parsed.segments;

            // fMP4：init + 分片本身就是合法 MP4，不需要 mux.js，输出必须是 .mp4
            const wantMp4 = opts.fmt === 'mp4' || parsed.fmp4;
            if (parsed.fmp4) appendLog('   检测到 fMP4（#EXT-X-MAP / .m4s），输出 .mp4');
            const suffix = (opts.stamp ? '_' + stamp() : '');
            const plannedName = baseName + suffix + (wantMp4 ? '.mp4' : '.ts');

            appendLog('   切片数: ' + segs.length +
                (parsed.encrypted ? '   AES-128 加密' : '') +
                (parsed.fmp4 ? '   fMP4' : '   TS'));

            appendLog('④ 下载切片（并发 ' + opts.threads + '，重试 ' + opts.retry + '）...');
            const datas = new Array(segs.length);
            const failures = [];   // {index, url, reason}
            let cursor = 0, done = 0;
            const keyCache = new Map();

            const worker = async () => {
                while (true) {
                    const i = cursor++;
                    if (i >= segs.length) break;
                    const seg = segs[i];
                    let lastErr = null;
                    for (let t = 0; t < opts.retry; t++) {
                        try {
                            const got = await downloadSegment(seg, keyCache, 0);
                            datas[i] = got.bytes;
                            done++;
                            if (done % 10 === 0 || done === segs.length) appendLog('   ' + done + '/' + segs.length);
                            lastErr = null;
                            break;
                        } catch (e) {
                            lastErr = e;
                            // 指数退避，避免瞬时失败时立刻重试打爆 CDN
                            if (t < opts.retry - 1) await new Promise((r) => setTimeout(r, 400 * (t + 1)));
                        }
                    }
                    if (lastErr) failures.push({ index: i + 1, url: seg.url, reason: lastErr.message });
                }
            };
            await Promise.all(Array.from({ length: opts.threads }, worker));

            // 失败诊断：序号 + URL + 原因 + 可操作的排查建议
            if (failures.length) {
                appendLog('   ❌ ' + failures.length + ' 个切片失败：');
                failures.slice(0, 5).forEach((f) => {
                    appendLog('      #' + f.index + '  ' + f.reason);
                    appendLog('         ' + f.url.slice(0, 110));
                });
                if (failures.length > 5) appendLog('      …另有 ' + (failures.length - 5) + ' 个');
                const allAuth = failures.every((f) => /HTTP (401|403)/.test(f.reason));
                const all404 = failures.every((f) => /HTTP 404/.test(f.reason));
                if (allAuth) appendLog('   建议：多为 auth_key 签名过期（约 10 天有效期），刷新页面重新获取链接。');
                else if (all404) appendLog('   建议：切片已过期或被清理，回放可能已失效。');
                else appendLog('   建议：可降低并发线程数后重试，或点「检查更新」确认脚本为最新版。');
                throw new Error('下载未完成：' + failures.length + '/' + segs.length + ' 个切片失败');
            }

            appendLog('⑤ 拼接 ...');
            let blob, outName = plannedName, note = '';
            if (parsed.fmp4) {
                try {
                    if (!parsed.initSegment) throw new Error('缺少 #EXT-X-MAP 初始化段地址');
                    const init = await getBinary(parsed.initSegment.url, null);
                    blob = new Blob([init, ...datas], { type: 'video/mp4' });
                    appendLog('   fMP4 直接拼接成功（init + ' + datas.length + ' 分片）');
                } catch (e) {
                    note = '（fMP4 初始化段下载失败：' + e.message + '，已输出分片部分）';
                    blob = new Blob(datas, { type: 'video/mp4' });
                }
            } else if (wantMp4) {
                try {
                    blob = await remuxToMp4(datas);
                    appendLog('   MP4 转封装成功');
                } catch (e) {
                    note = '（MP4 转封装失败，已回退为 TS：' + e.message + '）';
                    blob = new Blob(datas, { type: 'video/MP2T' });
                    outName = baseName + suffix + '.ts';
                }
            } else {
                blob = new Blob(datas, { type: 'video/MP2T' });
            }
            if (note) appendLog('   ' + note);
            appendLog('   生成 ' + (blob.size / 1048576).toFixed(1) + ' MB');

            appendLog('⑥ 保存文件 ...');
            await downloadBlob(blob, outName, opts.remember);
            setStatus('✅ 完成：' + outName);
        } catch (err) {
            setStatus('❌ 失败：' + err.message, true);
        } finally {
            goBtn.disabled = false;
        }
    }

    // ---------- 初始化（等 body 就绪再挂载） ----------
    function init() {
        document.body.appendChild(panel);
        statusEl = $('dlr-status');
        // 回放挂载前缓存的日志
        if (logBuffer.length) {
            statusEl.textContent = logBuffer.join('\n');
            logBuffer.length = 0;
        }

        $('dlr-go').addEventListener('click', () => {
            const raw = ($('dlr-url').value || '').trim() || location.href;
            const opts = {
                fmt: $('dlr-fmt').value,
                threads: Math.max(1, Math.min(16, parseInt($('dlr-thread').value, 10) || 5)),
                retry: Math.max(1, Math.min(10, parseInt($('dlr-retry').value, 10) || 3)),
                remember: $('dlr-remember').checked,
                stamp: $('dlr-stamp').checked,
            };
            try {
                const { roomId, liveUuid } = parseUrl(raw);
                run(roomId, liveUuid, opts);
            } catch (e) {
                setStatus('❌ ' + e.message, true);
            }
        });

        try {
            const p = parseUrl(location.href);
            $('dlr-url').value = location.href;
            setStatus('检测到直播 roomId=' + p.roomId + '  liveUuid=' + p.liveUuid.slice(0, 8) + '...。点击「下载本页回放」。');
        } catch (e) {
            // 当前页不是直播详情页
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();