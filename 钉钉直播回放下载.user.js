// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      1.8.1
// @description  钉钉直播回放下载器：免登录抓取 m3u8，支持 MP4(默认,已修时长/进度条)/TS、截取时长、内置预览(倍速/音量)、毛玻璃面板、收缩为图标、并发与重试、多码率、AES-128、fMP4、进度动画。
// @author       agent
// @license      MIT
// @match        https://n.dingtalk.com/dingding/live-room/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
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
    const UPDATE_URL = 'https://raw.githubusercontent.com/Vectg/dingtalk-live-replay-downloader/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js';
    const UPDATE_URL_FALLBACK = 'https://gitee.com/Vectg/dingtalk-live-replay-downloader/raw/main/%E9%92%89%E9%92%89%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js';
    const VERSION = (() => {
        try { return (GM_info && GM_info.script && GM_info.script.version) || '未知'; }
        catch (e) { return '未知'; }
    })();

    // ---------- 日志：面板挂载前的日志先缓存，避免静默丢失 ----------
    const logBuffer = [];
    let statusEl = null;

    // 输出历史：默认只显示最新一条，点击状态栏展开查看全部（最多留 300 条）
    const logHistory = [];
    function pushHistory(line) {
        logHistory.push(line);
        if (logHistory.length > 300) logHistory.shift();
        const s = $('dlr-status');
        if (s && s.classList.contains('hist')) {
            s.textContent = logHistory.join('\n');
            s.scrollTop = s.scrollHeight;
        }
    }
    function appendLog(msg) {
        const now = new Date();
        const t = String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':' +
            String(now.getSeconds()).padStart(2, '0');
        const line = t + '  ' + String(msg);
        if (!statusEl) {
            logBuffer.push(line);
            if (logBuffer.length > 200) logBuffer.shift();
            return;
        }
        pushHistory(line);
        // 默认只保留最新一行（展开历史时 pushHistory 内部会渲染全量）
        if (!statusEl.classList.contains('hist')) statusEl.textContent = line;
    }

    function setStatus(msg, isErr) {
        const raw = String(msg);
        if (!statusEl) {
            logBuffer.length = 0;
            logBuffer.push(isErr ? raw + '（面板未挂载）' : raw);
            return;
        }
        pushHistory((isErr ? '❌ ' : '') + raw);
        if (statusEl.classList.contains('hist')) return;   // 展开态由 pushHistory 渲染
        // 用 textContent/DOM 构造，不走 innerHTML —— 从根上免去 HTML 转义
        statusEl.textContent = '';
        if (isErr) {
            const sp = document.createElement('span');
            sp.className = 'err';
            sp.textContent = raw;
            statusEl.appendChild(sp);
        } else {
            statusEl.textContent = raw;
        }
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
    // 空名返回 null（表示「用默认」），不是 'replay'——否则回放标题永远无法回退
    function sanitize(name) {
        let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
        if (s.length > 120) s = s.slice(0, 120);
        return s || null;
    }
    // 语义化版本比较：a>b 返回 1，相等 0，a<b 返回 -1
    function compareVersions(a, b) {
        const pa = String(a || '0').split('.');
        const pb = String(b || '0').split('.');
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const na = parseInt(pa[i], 10) || 0;
            const nb = parseInt(pb[i], 10) || 0;
            if (na > nb) return 1;
            if (na < nb) return -1;
        }
        return 0;
    }
    // 给一个非空兜底名（真正要用默认值时调用）
    function safeName(name, fallback) {
        const s = sanitize(name);
        return (s && s.replace(/\.(mp4|ts|m4s|mp3)$/i, '')) || fallback || 'replay';
    }

    function stamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    // 不弹保存对话框：GM_download 的 saveAs 对话框在油猴里点「取消」也不会回传任何回调，
    // 无法可靠判断是否已取消（超时猜测会造成「点取消却仍在下载」）。改为直接交给浏览器
    // 存到默认下载目录，无对话框、无需取消判断。
    function downloadBlob(blob, filename) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            let fellBack = false;
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            const fail = (e) => { if (!settled) { settled = true; reject(e); } };
            function cleanup() { setTimeout(() => URL.revokeObjectURL(url), 15000); }
            function anchorFallback() {
                const a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click(); a.remove();
                cleanup();
                setTimeout(() => done('saved'), 300);
            }
            try {
                GM_download({
                    url, name: filename, saveAs: false,
                    onload: () => { cleanup(); done('saved'); },
                    onerror: (e) => {
                        if (!fellBack) { fellBack = true; anchorFallback(); }
                        else fail(new Error('保存失败 ' + (e && e.error ? e.error : '')));
                    },
                    ontimeout: () => {
                        if (!fellBack) { fellBack = true; anchorFallback(); }
                        else fail(new Error('保存超时'));
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
        // 关键：mux.js 输出是给 MSE 流式播放用的，moov 里 mvhd/tkhd/mdhd 的 duration
        // 被写成 0xFFFFFFFF（=unknown 哨兵），播放器会显示成 13+ 小时且无法拖动进度条。
        // 必须扫描 moof(tfdt+trun) 算出真实时长后写回。
        const patched = fixMp4Duration(mergeBuffers([init, ...frags]));
        return new Blob([patched], { type: 'video/mp4' });
    }

    // ---------- MP4 moov duration 修补 ----------
    function mergeBuffers(arrs) {
        let total = 0;
        for (const a of arrs) total += a.byteLength;
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of arrs) { out.set(a, off); off += a.byteLength; }
        return out;
    }

    function boxIter(dv, start, end) {
        const out = [];
        let pos = start;
        while (pos + 8 <= end) {
            let size = dv.getUint32(pos);
            const type = String.fromCharCode(
                dv.getUint8(pos + 4), dv.getUint8(pos + 5),
                dv.getUint8(pos + 6), dv.getUint8(pos + 7));
            let hdr = 8;
            if (size === 1) { size = Number(dv.getBigUint64(pos + 8)); hdr = 16; }
            else if (size === 0) { size = end - pos; }
            if (size < hdr || pos + size > end) break;
            out.push({ type, start: pos, hdr, size });
            pos += size;
        }
        return out;
    }

    function findBox(dv, start, end, path) {
        let s = start, e = end, hit = null;
        for (const part of path.split('/')) {
            hit = null;
            for (const b of boxIter(dv, s, e)) if (b.type === part) { hit = b; break; }
            if (!hit) return null;
            s = hit.start + hit.hdr;
            e = hit.start + hit.size;
        }
        return hit;
    }

    function writeInt(dv, off, len, val) {
        if (len === 8) dv.setBigUint64(off, BigInt(val));
        else dv.setUint32(off, val >>> 0);
    }

    // 扫描 moov + moof，把 mvhd/tkhd/mdhd 里 0xFFFFFFFF 的哨兵 duration 改成真实时长
    function fixMp4Duration(u8) {
        try {
            const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            const top = {};
            for (const b of boxIter(dv, 0, dv.byteLength)) top[b.type] = b;
            if (!top.moov || !top.moof) return u8;
            const moovS = top.moov.start + top.moov.hdr;
            const moovE = top.moov.start + top.moov.size;

            const mvhd = findBox(dv, moovS, moovE, 'mvhd');
            if (!mvhd) return u8;
            const mvBase = mvhd.start + mvhd.hdr;
            const mvVer = dv.getUint8(mvBase);
            let mvTs, mvDurOff, mvDurLen;
            if (mvVer === 1) { mvTs = dv.getUint32(mvBase + 20); mvDurOff = mvBase + 24; mvDurLen = 8; }
            else { mvTs = dv.getUint32(mvBase + 12); mvDurOff = mvBase + 16; mvDurLen = 4; }
            if (!mvTs) return u8;
            // 只处理哨兵值（0xFFFFFFFF / 0xFFFFFFFFFFFFFFFF），正常的不碰
            const curMv = mvDurLen === 8 ? Number(dv.getBigUint64(mvDurOff)) : dv.getUint32(mvDurOff);
            if (curMv !== 4294967295 && curMv !== 18446744073709551615) return u8;

            // 收集 trak
            const traks = [];
            for (const t of boxIter(dv, moovS, moovE)) {
                if (t.type !== 'trak') continue;
                const ts = t.start + t.hdr, te = t.start + t.size;
                const tkhd = findBox(dv, ts, te, 'tkhd');
                const mdhd = findBox(dv, ts, te, 'mdia/mdhd');
                if (!tkhd || !mdhd) continue;
                const tkBase = tkhd.start + tkhd.hdr;
                const tkVer = dv.getUint8(tkBase);
                const trackId = dv.getUint32(tkBase + 12);
                const tkDurOff = tkBase + (tkVer === 1 ? 28 : 20);
                const tkDurLen = tkVer === 1 ? 8 : 4;
                const mdBase = mdhd.start + mdhd.hdr;
                const mdVer = dv.getUint8(mdBase);
                let mdTs, mdDurOff, mdDurLen;
                if (mdVer === 1) { mdTs = dv.getUint32(mdBase + 20); mdDurOff = mdBase + 24; mdDurLen = 8; }
                else { mdTs = dv.getUint32(mdBase + 12); mdDurOff = mdBase + 16; mdDurLen = 4; }
                traks.push({ trackId, tkDurOff, tkDurLen, mdTs, mdDurOff, mdDurLen });
            }

            // 扫描所有 moof/traf，算每轨真实结束时间
            const ends = new Map();
            for (const b of boxIter(dv, 0, dv.byteLength)) {
                if (b.type !== 'moof') continue;
                const ms = b.start + b.hdr, me = b.start + b.size;
                for (const traf of boxIter(dv, ms, me)) {
                    if (traf.type !== 'traf') continue;
                    const as_ = traf.start + traf.hdr, ae = traf.start + traf.size;
                    let tid = null, bmt = null, sumDur = 0, hasDur = false;
                    for (const c of boxIter(dv, as_, ae)) {
                        const cb = c.start + c.hdr;
                        if (c.type === 'tfhd') tid = dv.getUint32(cb + 4);
                        else if (c.type === 'tfdt') bmt = dv.getUint8(cb) === 1 ? Number(dv.getBigUint64(cb + 4)) : dv.getUint32(cb + 4);
                        else if (c.type === 'trun') {
                            const flags = (dv.getUint8(cb + 1) << 16) | (dv.getUint8(cb + 2) << 8) | dv.getUint8(cb + 3);
                            const n = dv.getUint32(cb + 4);
                            let o = cb + 8;
                            if (flags & 0x1) o += 4;
                            if (flags & 0x4) o += 8;
                            const step = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) +
                                (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
                            if (flags & 0x100) {
                                for (let i = 0; i < n; i++) sumDur += dv.getUint32(o + i * step);
                                hasDur = true;
                            }
                        }
                    }
                    if (tid !== null && bmt !== null && hasDur) {
                        const end = bmt + sumDur;
                        if (!ends.has(tid) || ends.get(tid) < end) ends.set(tid, end);
                    }
                }
            }

            let realMovie = 0;
            for (const t of traks) {
                const eu = ends.get(t.trackId) || 0;
                if (!eu || !t.mdTs) continue;
                const sec = eu / t.mdTs;
                if (sec > realMovie) realMovie = sec;
                writeInt(dv, t.mdDurOff, t.mdDurLen, Math.round(sec * t.mdTs));
                writeInt(dv, t.tkDurOff, t.tkDurLen, Math.round(sec * mvTs));
            }
            if (!realMovie) return u8;
            const limit = Math.pow(2, mvDurLen * 8) - 2;
            writeInt(dv, mvDurOff, mvDurLen, Math.min(Math.round(realMovie * mvTs), limit));
            return u8;
        } catch (e) {
            // 修补失败不影响产出文件（ffprobe 类播放器会重算），记录但不中断
            try { appendLog('   ⚠ MP4 duration 修补失败: ' + e.message); } catch (e2) { }
            return u8;
        }
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

    async function fetchAndParseM3u8(url, depth = 0, wantRes = '') {
        if (depth > 5) throw new Error('m3u8 嵌套层级过多');
        const text = await getText(url, '');
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

        const variants = [];
        const segments = [];
        let currentKey = null;
        let currentMap = null;        // #EXT-X-MAP 初始化段（fMP4）
        let pending = null;
        let pendingRange = null;     // #EXT-X-BYTERANGE
        let pendingDur = 0;          // 当前 #EXTINF 时长
        let pendingRes = '';         // #EXT-X-STREAM-INF 的 RESOLUTION
        let segClock = 0;            // 时间轴：当前切片的起始时间（秒）
        let mediaSequence = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSequence = parseInt(line.split(':')[1], 10) || 0;
                continue;
            }
            if (line.startsWith('#EXTINF:')) {
                const d = parseFloat(line.slice('#EXTINF:'.length));
                pendingDur = (isFinite(d) && d > 0) ? d : 0;
                continue;
            }
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
                pending = parseInt(attrs.BANDWIDTH || '0', 10) || 0;
                pendingRes = String(attrs.RESOLUTION || '');
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
                    variants.push({ url: u, bandwidth: pending, res: pendingRes });
                    pending = null;
                    pendingRes = '';
                } else {
                    const segStart = segClock;
                    segments.push({
                        url: u,
                        sequence: mediaSequence + segments.length,
                        key: currentKey ? { ...currentKey } : null,
                        map: currentMap ? { ...currentMap } : null,
                        byterange: pendingRange,
                        dur: pendingDur,
                        start: segStart,
                    });
                    segClock = segStart + pendingDur;
                    pendingRange = null;
                    pendingDur = 0;
                }
            }
        }

        if (variants.length) {
            variants.sort((a, b) => b.bandwidth - a.bandwidth);
            // 按用户选择的分辨率挑变体；未选（自动）时取最高带宽 = 原始分辨率
            let pick = variants[0];
            if (wantRes) {
                const hit = variants.find((v) => v.res === wantRes);
                if (hit) pick = hit;
                else appendLog('   找不到分辨率 ' + wantRes + '，回落最高带宽 ' + pick.bandwidth + ' bps');
            }
            appendLog('   多码率 ' + variants.length + ' 档，选择 ' +
                (pick.res || '未标注分辨率') + ' · ' + pick.bandwidth + ' bps');
            const inner = await fetchAndParseM3u8(pick.url, depth + 1, '');
            inner.variants = variants;   // 供分辨率下拉框填充
            return inner;
        }
        if (!segments.length) throw new Error('m3u8 无切片');

        // fMP4 判定：有 #EXT-X-MAP，或切片后缀是 .m4s/.mp4
        const withMap = segments.find((s) => s.map);
        const looksFmp4 = !!withMap ||
            segments.some((s) => /\.(m4s|mp4)(\?|$)/i.test(s.url));
        const encrypted = segments.some((s) => s.key && s.key.method === 'AES-128');
        const totalDur = segments.reduce((a, s) => a + (s.dur || 0), 0);

        return {
            playlistUrl: url,
            segments,
            encrypted,
            fmp4: looksFmp4,
            initSegment: withMap ? withMap.map : null,
            totalDur,
            variants: [],
        };
    }

    // ---------- 截取：按时间区间筛切片（HLS 按切片边界对齐，非帧级精确） ----------
    function parseTimeArg(v, label) {
        let s = String(v == null ? '' : v);
        // 自动修复常见输入问题：中文/全角冒号 → 半角，全角数字 → 半角，去空白与零宽字符
        s = s.replace(/[：︰﹕]/g, ':');
        s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        s = s.replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
        if (!s) return null;
        const who = label || '时间';
        if (!/^[0-9:.]+$/.test(s)) {
            throw new Error(who + '含非法字符，只接受数字与冒号（例：12:34 或 1:02:03），收到：' + v);
        }
        const p = s.split(':');
        if (p.length > 3) throw new Error(who + '最多 hh:mm:ss 两层冒号：' + v);
        if (p.some((x) => x === '')) throw new Error(who + '冒号不能连写或出现在两端：' + v);
        const n = p.map((x) => parseInt(x, 10));
        if (n.some((x) => !isFinite(x) || x < 0)) throw new Error(who + '必须为非负整数：' + v);
        // 秒位必须 ≤59；三位时分钟位也必须 ≤59（两位时首位是分钟，可超过 59，如 90:00）
        const ss = n[n.length - 1];
        if (ss > 59) throw new Error(who + '的秒位不能超过 59（得到 ' + ss + '），可用 ' + fmtTime(n.length === 1 ? n[0] : (n.length === 2 ? n[0] * 60 + ss : n[0] * 3600 + n[1] * 60 + ss)) + ' 表示：' + v);
        if (n.length === 3 && n[1] > 59) throw new Error(who + '的分钟位不能超过 59：' + v);
        if (n.length === 1) return n[0];
        if (n.length === 2) return n[0] * 60 + ss;
        return n[0] * 3600 + n[1] * 60 + ss;
    }

    function clipSegments(segs, from, to) {
        if (from === null && to === null) return { segs, range: null };
        const fullDur = segs.length
            ? segs[segs.length - 1].start + (segs[segs.length - 1].dur || 0)
            : 0;
        if (from !== null && from < 0) throw new Error('开始时间不能为负');
        if (to !== null && to < 0) throw new Error('结束时间不能为负');
        if (from !== null && to !== null && to <= from) {
            throw new Error('结束时间需晚于开始时间（开始 ' + fmtTime(from) +
                ' ≥ 结束 ' + fmtTime(to) + '）');
        }
        let fromS = from === null ? -Infinity : from;
        let toS = to === null ? Infinity : to;
        // 超出回放总时长：自动截到末尾（自动修复，不报错）
        let clamped = false;
        if (toS > fullDur) { toS = fullDur; clamped = true; }
        if (fromS !== -Infinity && fromS >= fullDur) {
            throw new Error('开始时间 ' + fmtTime(from) + ' 超出回放总时长 ' + fmtTime(fullDur));
        }
        // 与区间有交集的切片都保留
        const kept = segs.filter((s) => (s.start + (s.dur || 0)) > fromS && s.start < toS);
        if (!kept.length) throw new Error('所选时间段内没有切片（回放总时长 ' + fmtTime(fullDur) + '）');
        return {
            segs: kept,
            range: { from: fromS, to: toS, first: kept[0].start, last: kept[kept.length - 1].start + (kept[kept.length - 1].dur || 0), clamped },
        };
    }

    function fmtTime(s) {
        s = Math.max(0, Math.round(s));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        const p = (n) => String(n).padStart(2, '0');
        return h ? h + ':' + p(m) + ':' + p(ss) : p(m) + ':' + p(ss);
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
        #dlr-panel{position:fixed;right:16px;bottom:16px;z-index:999999;
            width:392px;padding:14px 16px;margin:0;border:0;background:transparent;box-shadow:none;
            border-radius:12px;
            transition:width 280ms cubic-bezier(0.16,1,0.3,1),
                padding 280ms cubic-bezier(0.16,1,0.3,1),
                border-radius 280ms cubic-bezier(0.16,1,0.3,1)}
        /* 下载中：整个面板最外层一圈流动的渐变光带。
           用 SVG 圆角矩形路径 + stroke-dash 动画，而不是旋转 border——
           非正方形元素旋转会翻转（看起来抖、假），SVG dash 沿路径流动不翻转。
           颜色与 3s 慢速取自参考站 web-motion-showcase 的 Border Beam：
           conic 渐变 transparent→蓝→#38bdf8→#ec4899，3s linear infinite。 */
        #dlr-ring{position:fixed;pointer-events:none;z-index:1000000;overflow:visible;
            opacity:0;transition:opacity 400ms ease-out}
        #dlr-ring.on{opacity:1}
        #dlr-ring .ring-track{fill:none;stroke:rgba(61,110,255,.28);stroke-width:3}
        #dlr-ring .ring-beam{fill:none;stroke-width:3.5;stroke-linecap:round;
            filter:drop-shadow(0 0 5px rgba(61,110,255,.85));
            animation:dlrRingDash 3s linear infinite}
        @keyframes dlrRingDash{from{stroke-dashoffset:0}to{stroke-dashoffset:-400}}
        #dlr-panel .body{display:grid;grid-template-rows:1fr;position:relative;z-index:1;width:100%;overflow:hidden;
            background:#16181d;color:#d7d9de;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
            border:1px solid #2a2e37;border-radius:12px;
            box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.03);
            padding:14px 16px;
            transition:grid-template-rows 280ms cubic-bezier(0.16,1,0.3,1),
                opacity 200ms cubic-bezier(0.4,0,0.2,1),
                padding 280ms cubic-bezier(0.16,1,0.3,1),
                border-width 280ms cubic-bezier(0.16,1,0.3,1),
                border-radius 280ms cubic-bezier(0.16,1,0.3,1),
                width 280ms cubic-bezier(0.16,1,0.3,1)}
        /* 内容包裹层：grid-template-rows 从 1fr → 0fr 才能把 auto 高度平滑补间到 0 */
        #dlr-panel .bin{overflow:hidden;min-height:0;min-width:0}
        #dlr-panel.frost .body{backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%)}
        #dlr-panel h3{margin:0 0 2px;font-size:14px;font-weight:650;color:#f0f1f4;letter-spacing:.2px;
            /* 右侧让开绝对定位的「收起」按钮（约 42px 宽 + 8px 边距），避免标题被盖住 */
            padding-right:58px}
        #dlr-panel .sub{font-size:11px;color:#7d828d;margin-bottom:10px}
        #dlr-panel .sec{border-top:1px solid #23262e;padding-top:8px;margin-top:8px}
        #dlr-panel .sec:first-of-type{border-top:0;padding-top:0;margin-top:0}
        #dlr-panel .row{margin:6px 0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        #dlr-panel input[type=text]{flex:1;min-width:0;box-sizing:border-box;padding:6px 8px;background:#0f1115;
            color:#e8eaee;border:1px solid #2c303a;border-radius:6px;outline:none}
        #dlr-panel input[type=text]:focus{border-color:#3d6eff;box-shadow:0 0 0 2px rgba(61,110,255,.25)}
        #dlr-panel input[type=number]{width:60px;padding:5px 6px;background:#0f1115;color:#e8eaee;
            border:1px solid #2c303a;border-radius:6px;outline:none}
        #dlr-panel select{padding:5px 6px;background:#0f1115;color:#e8eaee;border:1px solid #2c303a;border-radius:6px;outline:none}
        #dlr-panel label{display:inline-block;min-width:64px;color:#9aa0ab;font-size:12px}
        #dlr-panel button{background:#2c303a;color:#d7d9de;border:1px solid #3a3f4b;border-radius:6px;
            padding:6px 12px;cursor:pointer;margin:0}
        #dlr-panel button:hover{background:#343946}
        #dlr-panel button:disabled{opacity:.5;cursor:not-allowed}
        #dlr-panel .chk{display:inline-flex;align-items:center;gap:5px;min-width:auto;font-size:12px;cursor:pointer;color:#9aa0ab}
        #dlr-panel .chk input{margin:0;accent-color:#3d6eff}
        #dlr-panel button.primary{background:#3d6eff;border-color:#3d6eff;color:#fff;font-size:13px;font-weight:600;
            padding:8px 16px;width:100%;border-radius:8px}
        #dlr-panel button.primary:hover{background:#2f5fd8}
        #dlr-progress{position:relative;height:22px;margin-top:10px;background:#0f1115;border:1px solid #23262e;
            border-radius:11px;overflow:hidden;display:none}
        #dlr-progress.on{display:block}
        #dlr-progress .bar{position:absolute;left:0;top:0;bottom:0;width:0%;background:#3d6eff;transition:width .25s ease;border-radius:11px}
        #dlr-progress .stripes{position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.16) 0 8px,transparent 8px 16px);background-size:32px 32px;animation:dlrSlide .6s linear infinite;pointer-events:none}
        #dlr-progress .pct{position:relative;display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:#fff;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.5)}
        #dlr-progress.done .stripes{animation:none;opacity:0}
        @keyframes dlrSlide{from{background-position:0 0}to{background-position:32px 0}}
        @keyframes dlrSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
        #dlr-spin{display:none;width:14px;height:14px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:dlrSpin .8s linear infinite;vertical-align:-2px;margin-right:6px}
        #dlr-status{margin-top:8px;padding:6px 8px;background:#0f1115;border:1px solid #23262e;border-radius:6px;
            white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#aeb3bd;
            min-height:28px;line-height:1.5;cursor:pointer}
        /* 点击状态栏 → 展开历史日志（再点收起，默认只显示最新一条） */
        #dlr-status.hist{max-height:170px;overflow-y:auto;cursor:ns-resize;
            border-color:#2f3542;scrollbar-width:thin}
        #dlr-status.hist::after{content:'— 点击收起 —';display:block;text-align:center;
            color:#5a5f6b;font-size:10px;margin-top:4px}
        #dlr-status:not(.hist)::before{content:'🕘 ';opacity:.55}
        #dlr-panel .err{color:#ff7a7a}
        #dlr-preview{display:none;margin-top:10px;border-top:1px solid #23262e;padding-top:10px}
        #dlr-preview .ph{position:relative;background:#000;border-radius:8px;overflow:hidden}
        #dlr-preview video{display:block;width:100%;max-height:230px;background:#000}
        #dlr-preview .px{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;border:0;
            border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;line-height:1.4;margin:0}
        #dlr-preview .pc{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px}
        #dlr-preview .pn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7d828d}
        #dlr-panel .tip{font-size:11px;color:#6d727c;margin-top:3px}
        /* 更多设置：可折叠小面板 */
        #dlr-panel .more-toggle{display:flex;align-items:center;justify-content:space-between;
            font-size:12px;color:#9aa0ab;cursor:pointer;user-select:none;
            padding:2px 0;transition:color 150ms cubic-bezier(0.4,0,0.2,1)}
        #dlr-panel .more-toggle:hover{color:#d7d9de}
        #dlr-panel .mt-ic{display:inline-block;width:6px;height:6px;box-sizing:border-box;
            border-right:2px solid #6d727c;border-bottom:2px solid #6d727c;
            transform:rotate(-45deg);
            transition:transform 260ms cubic-bezier(0.16,1,0.3,1),border-color 150ms ease}
        #dlr-panel .more-toggle[aria-expanded="true"] .mt-ic{transform:rotate(45deg);border-color:#3d6eff}
        #dlr-panel .more-body{display:grid;grid-template-rows:0fr;
            transition:grid-template-rows 260ms cubic-bezier(0.16,1,0.3,1),
                opacity 200ms cubic-bezier(0.4,0,0.2,1);opacity:0}
        #dlr-panel .more-body>div{overflow:hidden;min-height:0}
        #dlr-panel .more-body.open{grid-template-rows:1fr;opacity:1}
        #dlr-panel .more-body .row:first-child{margin-top:6px}
        /* 收缩态：横向长条——上面是名字，下面是进度条（解析蓝 / 下载绿） */
        #dlr-panel.mini{width:230px;padding:0;border-radius:12px}
        #dlr-panel.mini .body{width:230px;border-radius:12px;
            background:rgba(22,24,29,.85);
            grid-template-rows:0fr;opacity:0;padding:0;border-width:0;pointer-events:none}
        #dlr-panel.mini.frost .body{background:rgba(22,24,29,.55)}
        #dlr-panel.mini.frost .expand{background:rgba(22,24,29,.55);
            backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%)}
        #dlr-panel.mini .collapse{opacity:0}
        /* 展开态：默认隐藏收缩条 */
        #dlr-panel .expand{display:none;flex-direction:column;gap:7px;cursor:pointer;
            padding:9px 12px;color:#d7d9de;font-size:12px;user-select:none;
            background:rgba(22,24,29,.92);border-radius:12px;
            opacity:0;transition:opacity 200ms ease-out}
        #dlr-panel .expand .ex-row{display:flex;align-items:center;gap:7px;min-width:0}
        #dlr-panel .expand .lb{flex:1;min-width:0;white-space:nowrap;overflow:hidden;
            text-overflow:ellipsis;font-weight:600;letter-spacing:.2px}
        #dlr-panel .expand .ic{width:18px;height:18px;border-radius:50%;background:#3d6eff;
            color:#fff;display:flex;align-items:center;justify-content:center;
            font-size:10px;font-weight:700;flex:none}
        /* 收缩条进度：默认蓝（解析阶段），下载阶段转绿 */
        #dlr-panel .expand .ex-track{height:4px;border-radius:2px;overflow:hidden;
            background:rgba(255,255,255,.1)}
        #dlr-panel .expand .ex-bar{height:100%;width:0%;border-radius:2px;
            background:#3d6eff;transition:width .25s ease,background-color .3s ease}
        #dlr-panel .expand.dl .ex-bar{background:#22c55e}
        /* hover 不能改 background（会整块换成半透明白=白色糊），改为阴影层叠加 */
        #dlr-panel .expand:hover{box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),
            0 4px 16px rgba(0,0,0,.45)}
        /* 毛玻璃开：收缩条同样半透明+背景模糊（原先被 .expand 实心底盖住=没毛玻璃） */
        #dlr-panel.mini.frost .expand{background:rgba(22,24,29,.55);
            -webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%)}
        #dlr-panel .expand:active{transform:scale(.995)}
        #dlr-panel.mini .expand{display:flex;opacity:1}
        #dlr-panel.mini .expand:hover .ic{transform:scale(1.12)}
        #dlr-panel.mini .expand .ic{transition:transform 220ms cubic-bezier(0.16,1,0.3,1)}
        /* 收缩态内容淡出 + 高度折叠（单一过渡曲线，宽高同步，避免内容硬塌） */
        /* 收缩按钮（展开态右上角） */
        #dlr-panel .collapse{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.06);
            color:#9aa0ab;border:1px solid #2c303a;border-radius:5px;padding:1px 8px;
            cursor:pointer;font-size:12px;line-height:1.5;margin:0}
        #dlr-panel .collapse:hover{background:rgba(255,255,255,.12);color:#d7d9de}
        /* 作者标注 */
        #dlr-panel .foot{margin-top:10px;padding-top:7px;border-top:1px solid #23262e;
            font-size:11px;color:#6d727c;display:flex;gap:5px;align-items:center}
        #dlr-panel .foot a{color:#7d828d;text-decoration:none}
        #dlr-panel .foot a:hover{color:#3d6eff;text-decoration:underline}
        #dlr-panel .collapse{transition:opacity 150ms ease-out}
        #dlr-panel.mini .collapse{opacity:0}
        #dlr-panel.mini .expand .ic{
            transition:transform 220ms cubic-bezier(0.16,1,0.3,1)}
        #dlr-panel.mini .expand:hover .ic{transform:scale(1.12)}
        /* 按压触觉反馈 */
        #dlr-panel button:active{transform:scale(0.97)}
        #dlr-panel button{transition:background-color 150ms cubic-bezier(0.4,0,0.2,1),
            transform 150ms cubic-bezier(0.4,0,0.2,1),opacity 150ms ease-out}
        /* 尊重系统「减少动态效果」 */
        @media (prefers-reduced-motion:reduce){
            #dlr-panel,#dlr-panel *{transition-duration:0.01ms !important;animation-duration:0.01ms !important}
            #dlr-ring .ring-beam{animation:none !important}
        }
        /* 毛玻璃：半透明背景 + 背景模糊 + 高光描边。不透明时无模糊开销 */
        #dlr-panel.frost .body{background:rgba(22,24,29,.72);border-color:rgba(255,255,255,.09);
            box-shadow:0 12px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.07)}
        #dlr-panel.frost input[type=text],#dlr-panel.frost input[type=number],
        #dlr-panel.frost select,#dlr-panel.frost #dlr-status,#dlr-panel.frost #dlr-progress{
            background:rgba(10,11,14,.62)}
    `);

    const $ = (id) => document.getElementById(id);

    const panel = document.createElement('div');
    panel.id = 'dlr-panel';
    panel.className = 'wrap';
    // 注意：不要给 panel 设 position:relative 内联样式——会覆盖 CSS 的 position:fixed，
    // 导致面板掉进文档流（跑到页面左下角）。position:fixed 本身已足以作为收缩按钮的定位参照。
    panel.innerHTML = `
        <div class="expand" id="dlr-exp" title="点击展开面板">
            <div class="ex-row"><span class="ic">⬇</span><span class="lb" id="dlr-ex-title">钉钉直播回放下载</span></div>
            <div class="ex-track"><div class="ex-bar" id="dlr-ex-bar"></div></div>
        </div>
        <div class="body">
        <button class="collapse" title="收缩为图标">收起</button>
        <div class="bin">
        <h3>钉钉直播回放下载</h3>
        <div class="sub">免登录 · 公开接口抓取 m3u8</div>
        <div class="sec"><div class="row"><input type="text" id="dlr-url" placeholder="粘贴回放链接，或自动读取本页"></div></div>
        <div class="sec">
            <div class="row">
                <label>文件名</label>
                <input type="text" id="dlr-name" placeholder="回放标题解析中…" style="flex:1">
            </div>
            <div class="row">
                <label class="chk"><input type="checkbox" id="dlr-stamp">文件名加时间戳</label>
            </div>
            <div class="row">
                <label>格式</label>
                <select id="dlr-fmt" style="flex:1">
                    <option value="mp4" selected>.mp4（mux.js 转封装，默认）</option>
                    <option value="ts">.ts（原始拼接，最稳）</option>
                </select>
            </div>
            <div class="row">
                <label>分辨率</label>
                <select id="dlr-res" style="flex:1"><option value="">自动（原始分辨率）</option></select>
            </div>
            <div class="row">
                <label>截取</label>
                <input type="text" id="dlr-from" placeholder="开始 mm:ss" style="width:96px">
                <label style="min-width:16px">至</label>
                <input type="text" id="dlr-to" placeholder="结束 mm:ss" style="width:96px">
            </div>
            <div class="tip">截取留空为整段；按切片边界对齐（约 30 秒粒度），非帧级精确。</div>
        </div>
        <div class="sec"><div class="row"><button id="dlr-go" class="primary"><span id="dlr-spin"></span>下载本页回放</button></div></div>
        <div id="dlr-progress"><div class="bar"></div><div class="stripes"></div><div class="pct">0%</div></div>
        <div id="dlr-status">就绪。</div>
        <div id="dlr-ctl" class="row" style="display:none">
            <button id="dlr-pause" title="暂停/继续下载">⏸ 暂停</button>
            <button id="dlr-cancel" title="中断本次下载（已下载的可保留）">⏹ 中断</button>
            <button id="dlr-purge" title="删除全部已下载的切片缓存">🗑 删除已下载</button>
        </div>
        <div id="dlr-preview"></div>
        <div class="sec">
            <div class="more-toggle" id="dlr-more-t" role="button" aria-expanded="false">更多设置<span class="mt-ic"></span></div>
            <div class="more-body" id="dlr-more-b"><div>
                <div class="row">
                    <label>并发线程</label>
                    <input type="number" id="dlr-thread" min="1" max="16" value="5">
                    <label style="min-width:48px">重试</label>
                    <input type="number" id="dlr-retry" min="1" max="10" value="3">
                </div>
                <div class="row">
                    <label>面板状态</label>
                    <select id="dlr-mini-def" style="flex:1">
                        <option value="0" selected>默认展开</option>
                        <option value="1">默认收缩</option>
                    </select>
                </div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-prefetch">预取播放信息</label></div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-frost">毛玻璃</label></div>
                <div class="tip">预取播放地址与切片索引，打开页面后无需等待即可直接下载。</div>
            </div></div>
        </div>
        <div class="foot">
            <span>v<span id="dlr-ver">--</span></span>
            <span style="color:#3a3f4b">·</span>
            <span>By</span>
            <a href="https://github.com/Vectg" target="_blank" rel="noopener noreferrer">@Vectg</a>
            <button id="dlr-update" title="从 GitHub 拉取最新版">检查更新</button>
        </div>
        </div>
        </div>
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

    // ---------- 内置预览（倍速 / 音量） ----------
    function showPreview(blob, name) {
        let box = $('dlr-preview');
        if (!box) return;
        box.innerHTML = '';
        const holder = document.createElement('div');
        holder.className = 'ph';
        const close = document.createElement('button');
        close.className = 'px';
        close.textContent = '✕';
        close.title = '关闭预览';
        const v = document.createElement('video');
        v.src = URL.createObjectURL(blob);
        v.controls = true;
        holder.appendChild(close);
        holder.appendChild(v);
        box.appendChild(holder);

        // 控制行：倍速 + 音量
        const ctl = document.createElement('div');
        ctl.className = 'pc';
        const sp = document.createElement('select');
        sp.title = '倍速';
        [0.5, 0.75, 1, 1.25, 1.5, 2].forEach((r) => {
            const o = document.createElement('option');
            o.value = String(r);
            o.textContent = r + '×';
            if (r === 1) o.selected = true;
            sp.appendChild(o);
        });
        sp.addEventListener('change', () => { v.playbackRate = parseFloat(sp.value); });
        const vl = document.createElement('input');
        vl.type = 'range';
        vl.min = '0'; vl.max = '1'; vl.step = '0.05'; vl.value = '1';
        vl.title = '音量';
        vl.style.width = '84px';
        vl.addEventListener('input', () => { v.volume = parseFloat(vl.value); });
        const cap = document.createElement('div');
        cap.className = 'pn';
        cap.textContent = '预览：' + name;
        ctl.appendChild(cap);
        ctl.appendChild(sp);
        ctl.appendChild(vl);
        box.appendChild(ctl);

        close.addEventListener('click', () => {
            try { URL.revokeObjectURL(v.src); } catch (e) {}
            box.innerHTML = '';
            box.style.display = 'none';
        });
        box.style.display = 'block';
    }

    // ---------- 主流程 ----------
    // ---------- 进度条 ----------
    function progressReset() {
        const p = $('dlr-progress');
        const exp = $('dlr-exp');
        if (exp) exp.classList.remove('dl');   // 起始为解析阶段：蓝
        if (!p) return;
        p.classList.add('on');
        p.classList.remove('done');
        p.querySelector('.bar').style.width = '0%';
        p.querySelector('.pct').textContent = '0%';
        const xb = $('dlr-ex-bar'); if (xb) xb.style.width = '0%';
        const s = $('dlr-spin'); if (s) s.style.display = 'inline-block';
        panel.classList.add('dling');
        if (window.__ringShow) try { window.__ringShow(); } catch (e) {}
    }
    // phase: 'parse'(蓝) | 'download'(绿) —— 同步收缩条的颜色
    function setPhase(phase) {
        const exp = $('dlr-exp');
        if (exp) exp.classList.toggle('dl', phase === 'download');
    }
    function progressSet(pct, label) {
        const p = $('dlr-progress');
        if (!p) return;
        const v = Math.max(0, Math.min(100, Math.round(pct)));
        p.querySelector('.bar').style.width = v + '%';
        p.querySelector('.pct').textContent = label ? (label + ' ' + v + '%') : (v + '%');
        const xb = $('dlr-ex-bar');
        if (xb) xb.style.width = v + '%';   // 收缩条进度同步
    }
    function progressDone(ok) {
        const p = $('dlr-progress');
        const s = $('dlr-spin');
        if (s) s.style.display = 'none';
        panel.classList.remove('dling');
        if (window.__ringHide) try { window.__ringHide(); } catch (e) {}
        if (!p) return;
        if (ok) {
            progressSet(100, '完成');
            p.classList.add('done');
        } else {
            p.classList.remove('on');
        }
    }

    // ---------- 预解析：csrf → 播放地址 → m3u8，可被 run() 复用 ----------
    // 检测到回放页时后台先跑，点下载直接进入切片阶段；缓存 10 分钟。
    let prepCache = null;      // {key, at, token, model, parsed}
    const PREP_TTL = 10 * 60 * 1000;
    async function prep(roomId, liveUuid, wantRes) {
        wantRes = wantRes || '';
        const key = roomId + '|' + liveUuid + '|' + wantRes;
        const fresh = prepCache && prepCache.key === key &&
            (Date.now() - prepCache.at) < PREP_TTL;
        if (fresh) return prepCache;

        const token = await getCsrf();
        appendLog('① CSRF token (' + token.slice(0, 8) + '...)');
        appendLog('② 获取播放地址 getOpenLiveInfoV2 ...');
        const model = await getPlayback(roomId, liveUuid, token);
        appendLog('   标题: ' + model.title +
            '  时长: ' + (model.playbackDuration ? (model.playbackDuration / 1000).toFixed(1) + 's' : '未知'));
        appendLog('③ 拉取 m3u8 ...');
        const parsed = await fetchAndParseM3u8(model.playbackUrl, 0, wantRes);
        if (parsed.totalDur) {
            appendLog('   回放总时长 ' + fmtTime(parsed.totalDur) +
                '（' + parsed.segments.length + ' 个切片）');
        }
        prepCache = { key, at: Date.now(), token, model, parsed };
        return prepCache;
    }

    async function run(roomId, liveUuid, opts) {
        const goBtn = $('dlr-go');
        goBtn.disabled = true;
        progressReset();
        // 各阶段在整条进度条上的落点：切片下载占 5%~92%，其余为准备/转封装/保存
        const P = { prep: 5, dlStart: 5, dlEnd: 92, mux: 96, save: 99 };
        try {
            const { model, parsed } = await prep(roomId, liveUuid, opts.res);
            // 留空 = 用回放标题；填了则优先，并自动去掉误带的后缀
            const autoName = safeName(model.title, liveUuid);
            const baseName = safeName(opts.name, autoName);
            appendLog('   文件名: ' + baseName);
            progressSet(P.prep, '准备');

            // 截取：按时间区间筛切片（HLS 按切片边界对齐，非帧级精确）
            const clip = clipSegments(parsed.segments, opts.clipFrom, opts.clipTo);
            const segs = clip.segs;
            if (clip.range) {
                appendLog('   ✂ 截取 ' + fmtTime(clip.range.from) + ' ~ ' + fmtTime(clip.range.to) +
                    ' → 实际 ' + fmtTime(clip.range.first) + ' ~ ' + fmtTime(clip.range.last) +
                    '（' + segs.length + '/' + parsed.segments.length + ' 切片）' +
                    (clip.range.clamped ? '；结束时间超出总时长，已自动截到回放末尾' : ''));
            }

            // fMP4：init + 分片本身就是合法 MP4，不需要 mux.js，输出必须是 .mp4
            const wantMp4 = opts.fmt === 'mp4' || parsed.fmp4;
            if (parsed.fmp4) appendLog('   检测到 fMP4（#EXT-X-MAP / .m4s），输出 .mp4');
            const suffix = (opts.stamp ? '_' + stamp() : '');
            const clipTag = clip.range
                ? '_' + fmtTime(clip.range.from).replace(/:/g, '-') + '-' + fmtTime(clip.range.to).replace(/:/g, '-')
                : '';
            const plannedName = baseName + suffix + clipTag + (wantMp4 ? '.mp4' : '.ts');

            appendLog('   切片数: ' + segs.length +
                (parsed.encrypted ? '   AES-128 加密' : '') +
                (parsed.fmp4 ? '   fMP4' : '   TS'));
            progressSet(P.dlStart, '下载');
            setPhase('download');   // 进入下载阶段：收缩条转绿

            appendLog('④ 下载切片（并发 ' + opts.threads + '，重试 ' + opts.retry + '）...');
            const datas = new Array(segs.length);
            const failures = [];   // {index, url, reason}
            let cursor = 0, done = 0;
            const keyCache = new Map();
            const span = P.dlEnd - P.dlStart;
            const updProgress = () => progressSet(P.dlStart + (done / segs.length) * span,
                '切片 ' + done + '/' + segs.length);

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
                            updProgress();
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

            // 失败诊断：单行模式，压成一条总结 + 建议（合并进最终错误消息）
            if (failures.length) {
                const first = failures[0];
                const allAuth = failures.every((f) => /HTTP (401|403)/.test(f.reason));
                const all404 = failures.every((f) => /HTTP 404/.test(f.reason));
                let advice;
                if (allAuth) advice = '多为 auth_key 签名过期（约 10 天有效），刷新页面重新获取链接';
                else if (all404) advice = '切片已过期或被清理，回放可能已失效';
                else advice = '可降低并发线程数后重试，或点「检查更新」确认脚本为最新版';
                appendLog('❌ ' + failures.length + '/' + segs.length + ' 切片失败：#' + first.index + ' ' + first.reason);
                throw new Error(failures.length + '/' + segs.length + ' 切片失败（#' + first.index + ' ' + first.reason + '）。建议：' + advice);
            }

            appendLog('⑤ 拼接 ...');
            progressSet(P.mux, '拼接');
            let blob, outName = plannedName, note = '';
            if (parsed.fmp4) {
                try {
                    if (!parsed.initSegment) throw new Error('缺少 #EXT-X-MAP 初始化段地址');
                    const init = await getBinary(parsed.initSegment.url, null);
                    // 同样可能带 0xFFFFFFFF duration，一并修补
                    const fixed = fixMp4Duration(mergeBuffers([init, ...datas]));
                    blob = new Blob([fixed], { type: 'video/mp4' });
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

            progressSet(P.save, '保存');
            appendLog('⑥ 保存文件 ...');
            await downloadBlob(blob, outName);
            // MP4 直接在面板内预览（TS 浏览器无法解码，不预览）
            if (wantMp4) {
                try { showPreview(blob, outName); } catch (e) { /* 预览失败不影响下载 */ }
            }
            setStatus('✅ 完成：' + outName + '（已存入浏览器默认下载文件夹）');
            progressDone(true);
        } catch (err) {
            setStatus('❌ 失败：' + err.message, true);
            progressDone(false);
        } finally {
            goBtn.disabled = false;
        }
    }

    // ---------- 初始化（等 body 就绪再挂载） ----------
    function init() {
        document.body.appendChild(panel);
        // 下载光环是独立 SVG 层，挂在 body 下而非面板内部，
        // 避免面板的堆叠上下文/半透明背景影响光环渲染
        const NS = 'http://www.w3.org/2000/svg';
        const ring = document.createElementNS(NS, 'svg');
        ring.id = 'dlr-ring';
        const ringGrad = document.createElementNS(NS, 'linearGradient');
        ringGrad.setAttribute('id', 'dlrBeamGrad');
        ringGrad.setAttribute('x1', '0'); ringGrad.setAttribute('y1', '0');
        ringGrad.setAttribute('x2', '1'); ringGrad.setAttribute('y2', '1');
        [['0', '#3d6eff'], ['0.5', '#38bdf8'], ['1', '#ec4899']].forEach(([o, c]) => {
            const s = document.createElementNS(NS, 'stop');
            s.setAttribute('offset', o); s.setAttribute('stop-color', c);
            ringGrad.appendChild(s);
        });
        const ringTrack = document.createElementNS(NS, 'rect');
        ringTrack.setAttribute('class', 'ring-track');
        const ringBeam = document.createElementNS(NS, 'rect');
        ringBeam.setAttribute('class', 'ring-beam');
        ringBeam.setAttribute('stroke', 'url(#dlrBeamGrad)');
        ringBeam.setAttribute('pathLength', '400');
        ringBeam.setAttribute('stroke-dasharray', '110 290');
        ring.appendChild(ringGrad);
        ring.appendChild(ringTrack);
        ring.appendChild(ringBeam);
        document.body.appendChild(ring);
        // 光环跟随面板的位置和尺寸（含圆角）——SVG rect 几何
        const syncRing = () => {
            const r = panel.getBoundingClientRect();
            const W = r.width + 6, H = r.height + 6;
            ring.style.left = (r.left - 3) + 'px';
            ring.style.top = (r.top - 3) + 'px';
            ring.setAttribute('width', W);
            ring.setAttribute('height', H);
            const rx = Math.min(15, W / 2, H / 2);
            [ringTrack, ringBeam].forEach(el => {
                el.setAttribute('x', 2); el.setAttribute('y', 2);
                el.setAttribute('width', Math.max(0, W - 4));
                el.setAttribute('height', Math.max(0, H - 4));
                el.setAttribute('rx', rx);
            });
        };
        syncRing();
        // 光环显隐：用 .on 类切换（SVG 无 border，改由 CSS opacity 控制）
        const ringHide = () => { ring.classList.remove('on'); };
        const ringShow = () => { ring.classList.add('on'); syncRing(); };
        ringHide();
        // 收缩/展开动画期间逐帧同步（只在光环可见时跑）
        let ringRaf = 0;
        const ringAnimLoop = () => {
            syncRing();
            ringRaf = requestAnimationFrame(ringAnimLoop);
        };
        const ringAnimStart = () => { if (!ringRaf && ring.classList.contains('on')) ringAnimLoop(); };
        const ringAnimStop = () => { if (ringRaf) { cancelAnimationFrame(ringRaf); ringRaf = 0; } };
        panel.addEventListener('transitionstart', ringAnimStart);
        panel.addEventListener('transitionend', ringAnimStop);
        window.__ringShow = ringShow;
        window.__ringHide = ringHide;
        statusEl = $('dlr-status');
        // 点击状态栏：展开/收起历史日志
        statusEl.title = '点击展开/收起输出历史';
        statusEl.addEventListener('click', () => {
            const on = statusEl.classList.toggle('hist');
            if (on) {
                statusEl.textContent = logHistory.join('\n');
                statusEl.scrollTop = statusEl.scrollHeight;
            } else if (logHistory.length) {
                statusEl.textContent = logHistory[logHistory.length - 1];
            }
        });
        // 面板挂载前缓存的日志：并入历史，界面显示最后一条
        if (logBuffer.length) {
            logHistory.push(...logBuffer);
            statusEl.textContent = logBuffer[logBuffer.length - 1];
            logBuffer.length = 0;
        }

        // 更多设置：可折叠，默认收起
        const moreT = $('dlr-more-t'), moreB = $('dlr-more-b');
        const setMore = (open) => {
            moreT.setAttribute('aria-expanded', open ? 'true' : 'false');
            moreB.classList.toggle('open', open);
        };
        moreT.addEventListener('click', () =>
            setMore(moreT.getAttribute('aria-expanded') !== 'true'));

        // 持久化设置（thread/retry/prefetch/frost/stamp 共用一套读写）
        const bindNum = (id, key, min, max, def) => {
            const el = $(id);
            try { const v = parseInt(GM_getValue(key), 10); if (v >= min && v <= max) el.value = v; }
            catch (e) { el.value = def; }
            el.addEventListener('change', () => {
                const v = Math.max(min, Math.min(max, parseInt(el.value, 10) || def));
                el.value = v;
                try { GM_setValue(key, v); } catch (e) { }
            });
        };
        const bindChk = (id, key, def) => {
            const el = $(id);
            try { const v = GM_getValue(key); el.checked = (v === undefined || v === null) ? def : !!v; }
            catch (e) { el.checked = def; }
            el.addEventListener('change', () => {
                try { GM_setValue(key, el.checked); } catch (e) { }
            });
            return el;
        };
        bindNum('dlr-thread', 'dlr_thread', 1, 16, 5);
        bindNum('dlr-retry', 'dlr_retry', 1, 10, 3);
        bindChk('dlr-stamp', 'dlr_stamp', false);
        const prefetch = bindChk('dlr-prefetch', 'dlr_prefetch', true);   // 自动解析：默认开启

        // 分辨率：默认自动（原始=最高带宽）；预取后回填各档位，切换即重新预取
        const resSel = $('dlr-res');
        try { const rv = GM_getValue('dlr_res'); if (rv) resSel.value = rv; } catch (e) { }
        const fillResOptions = (variants) => {
            if (!resSel || !variants || variants.length < 2) return;
            const cur = resSel.value;
            resSel.innerHTML = '<option value="">自动（原始分辨率）</option>';
            variants.forEach((v) => {
                if (!v.res) return;
                const o = document.createElement('option');
                o.value = v.res;
                o.textContent = v.res + ' · ' + Math.round(v.bandwidth / 1000) + ' kbps';
                resSel.appendChild(o);
            });
            resSel.value = cur;   // 保留用户选择（不存在则回落"自动"）
        };
        resSel.addEventListener('change', () => {
            try { GM_setValue('dlr_res', resSel.value); } catch (e) { }
            // 切换分辨率 → 缓存键不同，直接重新预取，下载时秒用
            let p = null;
            try { p = parseUrl(($('dlr-url').value || '').trim() || location.href); } catch (e) { }
            if (p && prefetch.checked) {
                setStatus('⏳ 已切换分辨率，重新预取…');
                prep(p.roomId, p.liveUuid, resSel.value).then(() => {
                    if (window.__updateNameTip) window.__updateNameTip();
                    if (fillResOptions) fillResOptions(prepCache.parsed.variants);
                    setStatus('✅ 就绪 · ' + (prepCache.model.title || '未命名') +
                        ' · ' + prepCache.parsed.segments.length + ' 个切片，可开始下载');
                }).catch((e) => setStatus('⚠ 预取失败：' + e.message, true));
            }
        });

        // 文件名 placeholder：留空时直接显示回放标题（预取完成后回填）；
        // 勾选「加时间戳」时追加 _时间戳，且每秒自动刷新保持最新
        const nameInp = $('dlr-name');
        const stampChk = $('dlr-stamp');
        const updateNameTip = () => {
            if ((nameInp.value || '').trim()) return;   // 填了自定义名就不动 placeholder
            const title = prepCache && prepCache.model ? prepCache.model.title : '';
            let ph = title
                ? title
                : (prefetch.checked ? '回放标题解析中…' : '留空将使用回放标题');
            if (stampChk && stampChk.checked && title) ph += '_' + stamp();
            nameInp.placeholder = ph;
        };
        nameInp.addEventListener('input', updateNameTip);
        prefetch.addEventListener('change', updateNameTip);
        if (stampChk) stampChk.addEventListener('change', updateNameTip);
        window.__updateNameTip = updateNameTip;
        updateNameTip();
        // 时间戳每秒自动刷新（仅在勾选时间戳且未填自定义名时生效）
        setInterval(() => {
            if (stampChk && stampChk.checked &&
                !(nameInp.value || '').trim() && prepCache) updateNameTip();
        }, 1000);

        // 毛玻璃：默认开启，开关状态持久化，刷新后保留
        const frost = bindChk('dlr-frost', 'dlr_frost', false);   // 毛玻璃：默认关闭
        const applyFrost = () => panel.classList.toggle('frost', frost.checked);
        frost.addEventListener('change', applyFrost);
        applyFrost();

        // 版本号回填 + 检查更新（GitHub 不通时回落 Gitee）
        $('dlr-ver').textContent = VERSION;
        const upd = $('dlr-update');
        upd.addEventListener('click', async () => {
            const oldText = upd.textContent;
            upd.disabled = true;
            upd.textContent = '检查中…';
            const fetchVer = (url) => new Promise((res, rej) => {
                GM_xmlhttpRequest({
                    url, method: 'GET',
                    onload: (r) => (r.status >= 200 && r.status < 300) ? res(r.responseText) : rej(new Error('HTTP ' + r.status)),
                    onerror: () => rej(new Error('网络错误')),
                    ontimeout: () => rej(new Error('超时')),
                });
            });
            try {
                let txt;
                try {
                    txt = await fetchVer(UPDATE_URL);
                } catch (e1) {
                    appendLog('GitHub 不通，回落 Gitee');
                    txt = await fetchVer(UPDATE_URL_FALLBACK);
                }
                const m = txt.match(/@version\s+(\S+)/);
                if (!m) throw new Error('无法解析远程版本号');
                if (compareVersions(m[1], VERSION) > 0) {
                    setStatus('🔄 发现新版 ' + m[1] + '（当前 ' + VERSION + '），已打开更新页');
                    window.open(UPDATE_URL, '_blank');
                    upd.textContent = '已打开更新页';
                } else {
                    setStatus('✅ 已是最新版 v' + VERSION);
                    upd.textContent = '最新';
                }
            } catch (e) {
                setStatus('❌ 检查更新失败：' + e.message, true);
                upd.textContent = '失败';
            } finally {
                upd.disabled = false;
                setTimeout(() => { upd.textContent = oldText; }, 2600);
            }
        });

        // 收缩 / 展开：不用时缩成一个小图标，状态持久化
        // 宽度/内边距/圆角为定值可直接补间；内容用 opacity 淡出，高度随内容塌缩
        const applyMini = () => panel.classList.toggle('mini', miniState);
        let miniState = false;
        try {
            // 优先读「默认面板状态」选项；老用户保留 dlr_mini 兼容
            const def = GM_getValue('dlr_mini_def');
            if (def === '1' || def === '0') miniState = def === '1';
            else {
                const saved = GM_getValue('dlr_mini');
                miniState = !(saved === undefined || saved === null) && !!saved;
            }
        } catch (e) {}
        const setMini = (v) => {
            miniState = v;
            try { GM_setValue('dlr_mini', v); } catch (e) { }
            // 手动收起/展开同步为下次打开的默认状态
            if (miniDef) {
                miniDef.value = v ? '1' : '0';
                try { GM_setValue('dlr_mini_def', miniDef.value); } catch (e) { }
            }
            applyMini();
            // 光环跟随面板尺寸/圆角变化（收缩时 rx 要变大成药丸）
            if (typeof syncRing === 'function') syncRing();
        };
        // 默认展开/收缩：决定下次打开页面时的初始状态；手动收起/展开也会同步该选项
        const miniDef = $('dlr-mini-def');
        try { miniDef.value = GM_getValue('dlr_mini_def') === '1' ? '1' : '0'; } catch (e) { }
        miniDef.addEventListener('change', () => {
            try { GM_setValue('dlr_mini_def', miniDef.value); } catch (e) { }
            try { GM_setValue('dlr_mini', miniDef.value === '1'); } catch (e) { }
        });

        const exp = panel.querySelector('.expand');
        const col = panel.querySelector('.collapse');
        exp.addEventListener('click', () => setMini(false));
        col.addEventListener('click', () => {
            // 收缩后收缩条仍显示实时进度（标题+进度条），因此不再禁止下载中收起
            setMini(true);
        });
        applyMini();

        $('dlr-go').addEventListener('click', () => {
            const raw = ($('dlr-url').value || '').trim() || location.href;
            let clipFrom = null, clipTo = null;
            try {
                clipFrom = parseTimeArg($('dlr-from').value, '开始时间');
                clipTo = parseTimeArg($('dlr-to').value, '结束时间');
            } catch (e) {
                setStatus('❌ 截取时间错误：' + e.message, true);
                return;
            }
            const opts = {
                fmt: $('dlr-fmt').value,
                threads: Math.max(1, Math.min(16, parseInt($('dlr-thread').value, 10) || 5)),
                retry: Math.max(1, Math.min(10, parseInt($('dlr-retry').value, 10) || 3)),
                stamp: $('dlr-stamp').checked,
                clipFrom,
                clipTo,
                name: ($('dlr-name').value || '').trim(),
                res: $('dlr-res') ? $('dlr-res').value : '',
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
            setStatus('检测到回放 · roomId=' + p.roomId + ' · liveUuid=' + p.liveUuid.slice(0, 8) + '…');
            // 预解析：检测到回放页且开关开启时，后台先跑 csrf/播放地址/m3u8，
            // 点下载直接进入切片阶段。失败不打扰用户，状态栏提示即可。
            if (prefetch.checked) {
                setStatus('⏳ 正在预取播放地址与切片索引…');
                prep(p.roomId, p.liveUuid, resSel.value).then(() => {
                    if (window.__updateNameTip) window.__updateNameTip();
                    if (fillResOptions) fillResOptions(prepCache.parsed.variants);
                    setStatus('✅ 就绪 · ' + (prepCache.model.title || '未命名') +
                        ' · ' + prepCache.parsed.segments.length + ' 个切片，可开始下载');
                }).catch((e) => {
                    setStatus('⚠ 预取失败：' + e.message + '（点击下载将重新获取）', true);
                });
            } else {
                setStatus('检测到回放 · roomId=' + p.roomId +
                    ' · liveUuid=' + p.liveUuid.slice(0, 8) + '… · 点击「下载本页回放」');
            }
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