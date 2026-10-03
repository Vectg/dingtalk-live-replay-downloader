// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      1.2.0
// @description  通过公开接口获取钉钉直播回放 m3u8，下载全部切片，支持 TS 拼接 / MP4 转封装、多码率 m3u8、AES-128 解密、并发数与重试次数。无需登录。
// @author       agent
// @license      MIT
// @match        https://n.dingtalk.com/dingding/live-room/*
// @require      https://cdn.jsdelivr.net/npm/mux.js@6.0.1/dist/mux.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      *
// @connect      lv.dingtalk.com
// @connect      dtliving-sz.dingtalk.com
// @connect      dtlive-sz.dingtalk.com
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 常量 ----------
    const CSRF_URL = 'https://lv.dingtalk.com/csrf';
    const INFO_URL = 'https://lv.dingtalk.com/getOpenLiveInfoV2';
    const REFERER = 'https://n.dingtalk.com/';

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
        return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+$/, '') || 'replay';
    }

    function downloadBlob(blob, filename) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            let fellBack = false;
            function fallback() {
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(resolve, 300);
            }
            try {
                GM_download({
                    url, name: filename, saveAs: true,
                    onload: () => resolve(),
                    onerror: (e) => { if (!fellBack) { fellBack = true; fallback(); } else reject(e); },
                });
            } catch (e) {
                fallback();
            }
        });
    }

    // 用 mux.js（@require 已在脚本沙箱内可用）把 TS 切片转封装为 fMP4；失败抛错由调用方回退。
    function remuxToMp4(tsArray) {
        if (typeof muxjs === 'undefined' || !muxjs.mp4) {
            throw new Error('mux.js 未加载');
        }
        const transmuxer = new muxjs.mp4.Transmuxer();
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

    // ---------- m3u8 解析（支持 master/多码率 + AES-128） ----------
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
        let pending = null;      // 待解析的 STREAM-INF 带宽
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
                    });
                }
            }
        }

        if (variants.length) {
            variants.sort((a, b) => b.bandwidth - a.bandwidth);
            appendLog('   多码率，选择最高带宽 ' + variants[0].bandwidth + ' bps');
            return fetchAndParseM3u8(variants[0].url, depth + 1);
        }
        if (!segments.length) throw new Error('m3u8 无切片');

        const encrypted = segments.some((s) => s.key && s.key.method === 'AES-128');
        return { playlistUrl: url, segments, encrypted };
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
    async function downloadSegment(seg, keyCache) {
        let bytes = await getBinary(seg.url, '');
        if (seg.key && seg.key.method === 'AES-128') {
            const keyBytes = await getKeyBytes(seg.key, keyCache);
            bytes = await aesDecrypt(bytes, keyBytes, keyIv(seg.key.iv, seg.sequence));
        } else if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
            throw new Error('不支持的 HLS 加密方式: ' + seg.key.method);
        }
        return bytes;
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
        #dlr-status{margin-top:8px;padding:6px;background:#f6f6f6;border-radius:4px;white-space:pre-wrap;max-height:180px;overflow:auto}
        #dlr-panel .err{color:#c00}
    `);

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
        <div class="row"><button id="dlr-go">下载本页回放</button></div>
        <div id="dlr-status">就绪。</div>
    `;
    document.body.appendChild(panel);

    const $ = (id) => document.getElementById(id);
    const statusEl = $('dlr-status');
    function log(msg, isErr) {
        statusEl.innerHTML = (isErr ? '<span class="err">' : '') + String(msg).replace(/</g, '&lt;') + (isErr ? '</span>' : '');
    }
    function appendLog(msg) {
        statusEl.textContent += '\n' + msg;
        statusEl.scrollTop = statusEl.scrollHeight;
    }

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
            const wantMp4 = opts.fmt === 'mp4';
            const filename = baseName + (wantMp4 ? '.mp4' : '.ts');
            appendLog('   标题: ' + model.title + '  时长: ' + (model.playbackDuration / 1000).toFixed(1) + 's');

            appendLog('③ 拉取 m3u8 ...');
            const parsed = await fetchAndParseM3u8(model.playbackUrl);
            const segs = parsed.segments;
            appendLog('   切片数: ' + segs.length + (parsed.encrypted ? '   AES-128 加密' : ''));

            appendLog('④ 下载切片（并发 ' + opts.threads + '，重试 ' + opts.retry + '）...');
            const datas = new Array(segs.length);
            let cursor = 0, done = 0;
            const failed = [];
            const keyCache = new Map();
            const worker = async () => {
                while (true) {
                    const i = cursor++;
                    if (i >= segs.length) break;
                    let got = false;
                    for (let t = 0; t < opts.retry && !got; t++) {
                        try {
                            datas[i] = await downloadSegment(segs[i], keyCache);
                            got = true;
                            done++;
                            if (done % 10 === 0 || done === segs.length) appendLog('   ' + done + '/' + segs.length);
                        } catch (e) {
                            if (t === opts.retry - 1) failed.push(i + 1);
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: opts.threads }, worker));
            if (failed.length) throw new Error('有 ' + failed.length + ' 个切片下载失败: ' + failed.slice(0, 10).join(',') + ' ...');

            appendLog('⑤ 拼接 ...');
            let blob, note = '';
            if (wantMp4) {
                try {
                    blob = remuxToMp4(datas);
                    appendLog('   MP4 转封装成功');
                } catch (e) {
                    note = '（MP4 转封装失败，已回退为 TS：' + e.message + '）';
                    blob = new Blob(datas, { type: 'video/MP2T' });
                }
            } else {
                blob = new Blob(datas, { type: 'video/MP2T' });
            }
            if (note) appendLog('   ' + note);
            const finalName = note ? (baseName + '.ts') : filename;
            appendLog('   生成 ' + (blob.size / 1048576).toFixed(1) + ' MB');

            appendLog('⑥ 保存文件 ...');
            await downloadBlob(blob, finalName);
            log('✅ 完成：' + finalName);
        } catch (err) {
            log('❌ 失败：' + err.message, true);
        } finally {
            goBtn.disabled = false;
        }
    }

    $('dlr-go').addEventListener('click', () => {
        const raw = ($('dlr-url').value || '').trim() || location.href;
        const opts = {
            fmt: $('dlr-fmt').value,
            threads: Math.max(1, Math.min(16, parseInt($('dlr-thread').value, 10) || 5)),
            retry: Math.max(1, Math.min(10, parseInt($('dlr-retry').value, 10) || 3)),
        };
        try {
            const { roomId, liveUuid } = parseUrl(raw);
            run(roomId, liveUuid, opts);
        } catch (e) {
            log('❌ ' + e.message, true);
        }
    });

    try {
        const p = parseUrl(location.href);
        $('dlr-url').value = location.href;
        log('检测到直播 roomId=' + p.roomId + '  liveUuid=' + p.liveUuid.slice(0, 8) + '...。点击「下载本页回放」。');
    } catch (e) {
        // 当前页不是直播详情页，保持空
    }
})();