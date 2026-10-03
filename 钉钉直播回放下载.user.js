// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      1.6.4
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

    // ---------- 日志：面板挂载前的日志先缓存，避免静默丢失 ----------
    const logBuffer = [];
    let statusEl = null;

    function appendLog(msg) {
        if (!statusEl) {
            logBuffer.push(String(msg));
            if (logBuffer.length > 200) logBuffer.shift();
            return;
        }
        // 单行模式：只保留最新一行，前缀加时间
        const now = new Date();
        const t = String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':' +
            String(now.getSeconds()).padStart(2, '0');
        statusEl.textContent = t + '  ' + String(msg);
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
        let pendingDur = 0;          // 当前 #EXTINF 时长
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
            appendLog('   多码率，选择最高带宽 ' + variants[0].bandwidth + ' bps');
            return fetchAndParseM3u8(variants[0].url, depth + 1);
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
        };
    }

    // ---------- 截取：按时间区间筛切片（HLS 按切片边界对齐，非帧级精确） ----------
    function parseTimeArg(v) {
        const s = String(v || '').trim();
        if (!s) return null;
        if (!/^[0-9:.]+$/.test(s)) throw new Error('时间格式应为 mm:ss 或 hh:mm:ss');
        const p = s.split(':').map((x) => parseInt(x, 10) || 0);
        if (p.length === 1) return p[0];
        if (p.length === 2) return p[0] * 60 + p[1];
        return p[0] * 3600 + p[1] * 60 + p[2];
    }

    function clipSegments(segs, from, to) {
        if (from === null && to === null) return { segs, range: null };
        const fromS = from === null ? -Infinity : from;
        const toS = to === null ? Infinity : to;
        if (toS <= fromS) throw new Error('结束时间需晚于开始时间');
        // 与区间有交集的切片都保留
        const kept = segs.filter((s) => (s.start + (s.dur || 0)) > fromS && s.start < toS);
        if (!kept.length) throw new Error('所选时间段内没有切片（回放时长可能不足）');
        return {
            segs: kept,
            range: { from: fromS, to: toS, first: kept[0].start, last: kept[kept.length - 1].start + (kept[kept.length - 1].dur || 0) },
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
        #dlr-panel{position:fixed;right:16px;bottom:16px;z-index:999999;width:392px;
            background:#16181d;color:#d7d9de;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
            border:1px solid #2a2e37;border-radius:12px;
            box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.03);
            padding:14px 16px}
        #dlr-panel h3{margin:0 0 2px;font-size:14px;font-weight:650;color:#f0f1f4;letter-spacing:.2px}
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
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#aeb3bd;
            display:flex;align-items:center;min-height:28px}
        #dlr-panel .err{color:#ff7a7a}
        #dlr-preview{display:none;margin-top:10px;border-top:1px solid #23262e;padding-top:10px}
        #dlr-preview .ph{position:relative;background:#000;border-radius:8px;overflow:hidden}
        #dlr-preview video{display:block;width:100%;max-height:230px;background:#000}
        #dlr-preview .px{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;border:0;
            border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;line-height:1.4;margin:0}
        #dlr-preview .pc{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px}
        #dlr-preview .pn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7d828d}
        #dlr-panel .tip{font-size:11px;color:#6d727c;margin-top:3px}
        /* 收缩态：只显示一个小药丸图标 */
        #dlr-panel.mini{width:auto;max-width:200px;padding:0;border-radius:999px;overflow:hidden;
            background:rgba(22,24,29,.85)}
        #dlr-panel.mini .expand{padding:7px 13px;font-size:12px}
        #dlr-panel.mini .expand .lb{display:none}
        #dlr-panel.mini.frost{background:rgba(22,24,29,.55)}
        #dlr-panel.mini .collapse,
        #dlr-panel.mini h3,
        #dlr-panel.mini .sec,#dlr-panel.mini .sub,
        #dlr-panel.mini #dlr-progress,#dlr-panel.mini #dlr-status,#dlr-panel.mini #dlr-preview,
        #dlr-panel.mini .tip,#dlr-panel.mini .foot{display:none}
        #dlr-panel.mini .expand{display:flex}
        /* 展开态：默认隐藏展开按钮 */
        #dlr-panel .expand{display:none;align-items:center;gap:7px;cursor:pointer;
            padding:8px 14px;color:#d7d9de;font-size:12px;user-select:none}
        #dlr-panel .expand .ic{width:22px;height:22px;border-radius:50%;background:#3d6eff;
            color:#fff;display:flex;align-items:center;justify-content:center;
            font-size:12px;font-weight:700;flex:none}
        #dlr-panel .expand:hover{background:rgba(255,255,255,.05)}
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
        /* 毛玻璃：半透明背景 + 背景模糊 + 高光描边。不透明时无模糊开销 */
        #dlr-panel.frost{background:rgba(22,24,29,.72);-webkit-backdrop-filter:blur(14px) saturate(150%);
            backdrop-filter:blur(14px) saturate(150%);border-color:rgba(255,255,255,.09);
            box-shadow:0 12px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.07)}
        #dlr-panel.frost input[type=text],#dlr-panel.frost input[type=number],
        #dlr-panel.frost select,#dlr-panel.frost #dlr-status,#dlr-panel.frost #dlr-progress{
            background:rgba(10,11,14,.62)}
    `);

    const $ = (id) => document.getElementById(id);

    const panel = document.createElement('div');
    panel.id = 'dlr-panel';
    // 注意：不要给 panel 设 position:relative 内联样式——会覆盖 CSS 的 position:fixed，
    // 导致面板掉进文档流（跑到页面左下角）。position:fixed 本身已足以作为收缩按钮的定位参照。
    panel.innerHTML = `
        <div class="expand" title="展开面板"><span class="ic">⬇</span><span class="lb">钉钉直播回放下载</span></div>
        <button class="collapse" title="收缩为图标">收起</button>
        <h3>钉钉直播回放下载</h3>
        <div class="sub">免登录 · 公开接口抓取 m3u8</div>
        <div class="sec"><div class="row"><input type="text" id="dlr-url" placeholder="粘贴回放链接，或自动读取本页"></div></div>
        <div class="sec">
            <div class="row">
                <label>文件名</label>
                <input type="text" id="dlr-name" placeholder="留空 = 用回放标题" style="flex:1">
            </div>
            <div class="row">
                <label>格式</label>
                <select id="dlr-fmt" style="flex:1">
                    <option value="mp4" selected>.mp4（mux.js 转封装，默认）</option>
                    <option value="ts">.ts（原始拼接，最稳）</option>
                </select>
            </div>
            <div class="row">
                <label>截取</label>
                <input type="text" id="dlr-from" placeholder="开始 mm:ss" style="width:96px">
                <label style="min-width:16px">至</label>
                <input type="text" id="dlr-to" placeholder="结束 mm:ss" style="width:96px">
            </div>
            <div class="tip">截取留空为整段；按切片边界对齐（约 30 秒粒度），非帧级精确。</div>
        </div>
        <div class="sec">
            <div class="row">
                <label>并发线程</label>
                <input type="number" id="dlr-thread" min="1" max="16" value="5">
                <label style="min-width:48px">重试</label>
                <input type="number" id="dlr-retry" min="1" max="10" value="3">
            </div>
            <div class="row">
                <label class="chk"><input type="checkbox" id="dlr-remember">记住保存路径</label>
                <label class="chk"><input type="checkbox" id="dlr-stamp">文件名加时间戳</label>
                <label class="chk"><input type="checkbox" id="dlr-frost">毛玻璃</label>
            </div>
        </div>
        <div class="sec"><div class="row"><button id="dlr-go" class="primary"><span id="dlr-spin"></span>下载本页回放</button></div></div>
        <div id="dlr-progress"><div class="bar"></div><div class="stripes"></div><div class="pct">0%</div></div>
        <div id="dlr-status">就绪。</div>
        <div id="dlr-preview"></div>
        <div class="foot">作者 <a href="https://github.com/Vectg" target="_blank" rel="noopener noreferrer">@Vectg</a></div>
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
        if (!p) return;
        p.classList.add('on');
        p.classList.remove('done');
        p.querySelector('.bar').style.width = '0%';
        p.querySelector('.pct').textContent = '0%';
        const s = $('dlr-spin'); if (s) s.style.display = 'inline-block';
    }
    function progressSet(pct, label) {
        const p = $('dlr-progress');
        if (!p) return;
        const v = Math.max(0, Math.min(100, Math.round(pct)));
        p.querySelector('.bar').style.width = v + '%';
        p.querySelector('.pct').textContent = label ? (label + ' ' + v + '%') : (v + '%');
    }
    function progressDone(ok) {
        const p = $('dlr-progress');
        const s = $('dlr-spin');
        if (s) s.style.display = 'none';
        if (!p) return;
        if (ok) {
            progressSet(100, '完成');
            p.classList.add('done');
        } else {
            p.classList.remove('on');
        }
    }

    async function run(roomId, liveUuid, opts) {
        const goBtn = $('dlr-go');
        goBtn.disabled = true;
        progressReset();
        // 各阶段在整条进度条上的落点：切片下载占 5%~92%，其余为准备/转封装/保存
        const P = { prep: 5, dlStart: 5, dlEnd: 92, mux: 96, save: 99 };
        try {
            const token = await getCsrf();
            appendLog('① CSRF token (' + token.slice(0, 8) + '...)');

            appendLog('② 获取播放地址 getOpenLiveInfoV2 ...');
            const model = await getPlayback(roomId, liveUuid, token);
            const autoName = sanitize(model.title || liveUuid);
            // 面板填了文件名就优先用，并清掉用户可能误带的后缀
            const customName = sanitize(opts.name || '').trim();
            const baseName = customName.replace(/\.(mp4|ts|m4s|mp3)$/i, '') || autoName;
            appendLog('   标题: ' + model.title +
                '  时长: ' + (model.playbackDuration ? (model.playbackDuration / 1000).toFixed(1) + 's' : '未知') +
                (customName ? '  文件名: ' + baseName : ''));
            progressSet(P.prep, '准备');

            appendLog('③ 拉取 m3u8 ...');
            const parsed = await fetchAndParseM3u8(model.playbackUrl);
            if (parsed.totalDur) {
                appendLog('   回放总时长 ' + fmtTime(parsed.totalDur) + '（' + parsed.segments.length + ' 个切片）');
            }

            // 截取：按时间区间筛切片（HLS 按切片边界对齐，非帧级精确）
            const clip = clipSegments(parsed.segments, opts.clipFrom, opts.clipTo);
            const segs = clip.segs;
            if (clip.range) {
                appendLog('   ✂ 截取 ' + fmtTime(clip.range.from) + ' ~ ' + fmtTime(clip.range.to) +
                    ' → 实际 ' + fmtTime(clip.range.first) + ' ~ ' + fmtTime(clip.range.last) +
                    '（' + segs.length + '/' + parsed.segments.length + ' 切片）');
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
            await downloadBlob(blob, outName, opts.remember);
            // MP4 直接在面板内预览（TS 浏览器无法解码，不预览）
            if (wantMp4) {
                try { showPreview(blob, outName); } catch (e) { /* 预览失败不影响下载 */ }
            }
            setStatus('✅ 完成：' + outName);
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
        statusEl = $('dlr-status');
        // 面板挂载前缓存的日志：单行模式只回放最后一条
        if (logBuffer.length) {
            statusEl.textContent = logBuffer[logBuffer.length - 1];
            logBuffer.length = 0;
        }

        // 毛玻璃：默认开启，开关状态持久化，刷新后保留
        const frost = $('dlr-frost');
        try {
            const saved = GM_getValue('dlr_frost');
            frost.checked = (saved === undefined || saved === null) ? true : !!saved;
        } catch (e) {
            frost.checked = true;
        }
        const applyFrost = () => {
            panel.classList.toggle('frost', frost.checked);
            try { GM_setValue('dlr_frost', frost.checked); } catch (e) {}
        };
        frost.addEventListener('change', applyFrost);
        applyFrost();

        // 收缩 / 展开：不用时缩成一个小图标，状态持久化
        const applyMini = () => panel.classList.toggle('mini', miniState);
        let miniState = false;
        try {
            const saved = GM_getValue('dlr_mini');
            miniState = !(saved === undefined || saved === null) && !!saved;
        } catch (e) {}
        const setMini = (v) => {
            miniState = v;
            try { GM_setValue('dlr_mini', v); } catch (e) {}
            applyMini();
        };
        const exp = panel.querySelector('.expand');
        const col = panel.querySelector('.collapse');
        exp.addEventListener('click', () => setMini(false));
        col.addEventListener('click', () => {
            // 下载进行中不允许收缩，避免看不到进度
            if ($('dlr-go').disabled) {
                setStatus('⏳ 下载进行中，请先完成或失败后再收起面板。', true);
                return;
            }
            setMini(true);
        });
        applyMini();

        $('dlr-go').addEventListener('click', () => {
            const raw = ($('dlr-url').value || '').trim() || location.href;
            let clipFrom = null, clipTo = null;
            try {
                clipFrom = parseTimeArg($('dlr-from').value);
                clipTo = parseTimeArg($('dlr-to').value);
            } catch (e) {
                setStatus('❌ 截取时间格式错误：' + e.message, true);
                return;
            }
            const opts = {
                fmt: $('dlr-fmt').value,
                threads: Math.max(1, Math.min(16, parseInt($('dlr-thread').value, 10) || 5)),
                retry: Math.max(1, Math.min(10, parseInt($('dlr-retry').value, 10) || 3)),
                remember: $('dlr-remember').checked,
                stamp: $('dlr-stamp').checked,
                clipFrom,
                clipTo,
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