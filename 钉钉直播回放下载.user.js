// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      2.1.0
// @description  钉钉直播回放下载器：免登录抓取 m3u8，支持 MP4(默认,已修时长/进度条)/TS、截取时长、内置预览(倍速)、智能调度（贪心优先+并发自适应）、下载队列、自定义分辨率、完成/失败通知与提示音、失败切片单独重试、导出 m3u8 与诊断日志、毛玻璃面板、收缩为图标、并发与重试、多码率、AES-128、fMP4、进度动画。
// @author       agent
// @license      MIT
// @match        https://n.dingtalk.com/dingding/live-room/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
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

    // 通知开关初值；面板初始化时由 GM_getValue 覆盖。默认值与 bindChk 一致：
    // 系统通知开（无声可靠），提示音关（自动播放策略常拦，容易让人以为坏了）。
    // 做成 setter 而不是裸变量：notify/beep 被单元测试抽出单独执行时，
    // 闭包外的模块变量不在作用域内，必须有个显式注入点才能测。
    let notifyFlags = { desktop: true, sound: false };
    function setNotifyFlags(desktop, sound) {
        notifyFlags = { desktop: !!desktop, sound: !!sound };
    }

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

    // ---------- 诊断信息收集（供「导出诊断日志」用） ----------
    // 目标：用户点一下就能把完整现场导成 .txt 发给开发者，省掉来回截图/猜测。
    // 只收集本地状态，不含任何页面内容、不含 m3u8 签名串（签名是一次性的、
    // 贴出来也复现不了，反而容易被当成泄露凭证）。
    const DIAG = {
        errors: [],        // 未捕获异常 / GM 请求异常
        runs: [],          // 每次下载的结论
        startedAt: new Date(),
    };
    // 未捕获异常：真机排查最关键的一类信号，页面自己的 try/catch 抓不到的那些
    window.addEventListener('error', (e) => {
        DIAG.errors.push({
            t: new Date().toISOString(),
            msg: String((e && e.message) || e),
            src: String((e && e.filename) || '').slice(-120),
            line: (e && e.lineno) || 0,
        });
        if (DIAG.errors.length > 50) DIAG.errors.shift();
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = (e && e.reason) || {};
        DIAG.errors.push({
            t: new Date().toISOString(),
            msg: '未处理的 Promise 拒绝: ' + String(r && r.message ? r.message : r).slice(0, 300),
            src: '', line: 0,
        });
        if (DIAG.errors.length > 50) DIAG.errors.shift();
    });
    // 记一次下载结论。err 非空即失败。
    function diagRun(ok, summary, detail) {
        DIAG.runs.push({
            t: new Date().toISOString(),
            ok: !!ok,
            summary: String(summary || '').slice(0, 300),
            detail: detail ? String(detail).slice(0, 600) : '',
        });
        if (DIAG.runs.length > 20) DIAG.runs.shift();
    }

    // 把播放地址里的签名抹掉：诊断文本可能被贴到公开 issue 里
    function redactUrl(u) {
        return String(u || '').replace(/([?&](auth_key|authKey|token|sign|signature)=)[^&]*/gi, '$1<已抹除>');
    }

    function buildDiagReport() {
        const L = [];
        const push = (k, v) => L.push(k.padEnd(14, ' ') + ': ' + v);
        push('脚本版本', VERSION);
        push('生成时间', new Date().toLocaleString('zh-CN'));
        push('页面地址', redactUrl(location.href));
        push('浏览器', navigator.userAgent);
        push('脚本启动', DIAG.startedAt.toLocaleString('zh-CN'));
        push('硬件并发', String(navigator.hardwareConcurrency || '未知') +
            '（自动识别线程数 ' + Math.max(4, Math.min(16, (navigator.hardwareConcurrency || 4) * 2)) + '）');
        L.push('');

        // —— 下载历史 ——
        L.push('【下载记录】共 ' + DIAG.runs.length + ' 次');
        if (!DIAG.runs.length) L.push('  （本次会话没有点过下载）');
        DIAG.runs.forEach((r, i) => {
            L.push('  ' + (i + 1) + '. ' + r.t.replace('T', ' ').slice(0, 19) +
                '  ' + (r.ok ? '成功' : '失败') + '  ' + r.summary);
            if (r.detail) L.push('     ' + r.detail);
        });
        L.push('');

        // —— 解析结果 ——
        const pc = prepCache && prepCache.parsed;
        L.push('【解析结果】');
        if (!pc) {
            L.push('  （尚未解析成功——这本身就是关键信息：多为签名过期或接口被拦）');
        } else {
            push('  切片数', String(pc.segments.length));
            push('  总时长', fmtTime(pc.totalDur || 0));
            push('  加密', pc.encrypted ? '是（AES-128）' : '否');
            push('  fMP4', pc.fmp4 ? '是' : '否');
            if (pc.initSegment) push('  初始化段', redactUrl(pc.initSegment.url));
            if (pc.variants && pc.variants.length) {
                L.push('  多码率档位:');
                pc.variants.forEach((v) => {
                    L.push('    ' + (v.res || '未标注') + '  ' + v.bandwidth + ' bps');
                });
            }
        }
        L.push('');

        // —— 缓存与设置 ——
        L.push('【缓存与设置】');
        const cached = partial && partial.datas ? partial.datas.filter(Boolean).length : 0;
        push('  内存缓存', partial ? (cached + ' 片' + (partial.key ? '' : '（key 不匹配）')) : '无');
        const failed = lastFailed ? lastFailed.length : 0;
        push('  待重试', failed ? (failed + ' 片：#' + lastFailed.slice(0, 20).join(' #')) : '无');
        const readChk = (id, key, def) => {
            try { const v = GM_getValue(key); return v === undefined || v === null ? def : v; }
            catch (e) { return def; }
        };
        push('  并发线程', String(readChk('dlr-thread', 'dlr_thread', '默认')));
        push('  重试次数', String(readChk('dlr-retry', 'dlr_retry', '默认')));
        push('  预取', readChk(null, 'dlr_prefetch', true) ? '开' : '关');
        push('  通知', (readChk(null, 'dlr_notify_desktop', true) ? '开' : '关') + ' / 声音' +
            (readChk(null, 'dlr_notify_sound', false) ? '开' : '关'));
        L.push('');

        // —— 未捕获异常 ——
        L.push('【未捕获异常】共 ' + DIAG.errors.length + ' 条');
        if (!DIAG.errors.length) L.push('  （无）');
        DIAG.errors.forEach((e) => {
            L.push('  ' + e.t.replace('T', ' ').slice(0, 19) + '  ' + e.msg);
            if (e.src) L.push('     ' + e.src + ':' + e.line);
        });
        L.push('');
        L.push('【面板日志】最近 ' + logHistory.length + ' 条');
        logHistory.slice(-80).forEach((l) => L.push('  ' + l));
        L.push('');
        L.push('—— 报告结束 ——');
        return L.join('\n');
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
    // 字节 → 人类可读（体积预估与完整性校验日志用）
    function fmtBytes(b) {
        if (!(b > 0)) return '0 B';
        if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return Math.round(b / 1024) + ' KB';
        return b + ' B';
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

    // ---------- 完成/失败通知（系统通知 + 提示音） ----------
    // 提示音用 WebAudio 现场合成，不带 @resource 音频文件：少一个外部依赖，
    // 也不会因为 CDN 挂了就静音。浏览器自动播放策略会拦未交互页面的出声，
    // 所以 AudioContext 要在用户点击「下载」时预热（见 primeNotifyAudio）。
    // audioCtx 走 getter/setter 而不是裸 let：单元测试把这些函数从 IIFE 里抽出来
    // 单独执行时，闭包外的变量不在作用域内，裸 let 会直接 ReferenceError；
    // 有 setter 才能注入一个假 AudioContext 测出「完成 2 声 / 失败 3 声」。
    let _audioCtx = null;
    function getAudioCtx() { return _audioCtx; }
    function setAudioCtx(ctx) { _audioCtx = ctx; }
    function primeNotifyAudio() {
        if (!notifyFlags.sound) return;
        try {
            if (!_audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                _audioCtx = new AC();
            }
            if (_audioCtx.state === 'suspended') _audioCtx.resume();
        } catch (e) { /* 用户点过下载仍失败就静音，不影响下载 */ }
    }
    // times 里的数字直接是半音偏移（相对 C5），正数上行、负数下行：
    // 完成传 [0, 4]（C5→E5 上行两声），失败传 [0, -3, -7]（下行三声）。
    // 音量刻意压低（0.16）避免突兀。
    function beep(times, type) {
        if (!notifyFlags.sound) return;
        try {
            primeNotifyAudio();
            if (!_audioCtx || _audioCtx.state !== 'running') return;
            const now = _audioCtx.currentTime;
            times.forEach((semi, i) => {
                const osc = _audioCtx.createOscillator();
                const gain = _audioCtx.createGain();
                osc.type = type;
                osc.frequency.value = 523.25 * Math.pow(2, semi / 12);
                const t0 = now + i * 0.16;
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
                osc.connect(gain); gain.connect(_audioCtx.destination);
                osc.start(t0); osc.stop(t0 + 0.15);
            });
        } catch (e) { }
    }
    // text 只在通知里带一句结论，不塞整段错误详情（系统通知宽度有限，
    // 完整信息仍以面板历史为准）。onclick 让用户点通知能聚焦面板。
    function notify(title, text, ok) {
        try { beep(ok ? [0, 4] : [0, -3, -7], ok ? 'sine' : 'triangle'); }
        catch (e) { }
        if (!notifyFlags.desktop) return;
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({
                    title: title,
                    text: text,
                    timeout: 8000,
                    onclick: () => { try { window.focus(); } catch (e) { } },
                });
                return;
            }
        } catch (e) { }
        // 油猴未注入 GM_notification（极少见）时退回浏览器原生通知
        try {
            if (typeof Notification === 'undefined') return;
            if (Notification.permission === 'granted') new Notification(title, { body: text });
            else if (Notification.permission !== 'denied') Notification.requestPermission().catch(() => { });
        } catch (e) { }
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

    // ---------- 导出 .m3u8 播放列表 ----------
    // 用途：把当前选中的这一路（原始/指定分辨率）导出成标准 m3u8，
    // 便于用 VLC / ffmpeg / 另一个下载器重新拉取，或存档。
    // 只导出当前 clips 对应的媒体清单，不含 master 的多码率分支——
    // 因为切片已被选定，再嵌多码率反而会让别的播放器重新选一次。
    function buildM3u8(parsed, baseName) {
        const segs = parsed.segments || [];
        const L = [];
        L.push('#EXTM3U');
        L.push('#EXT-X-VERSION:3');
        L.push('#EXT-X-PLAYLIST-TYPE:VOD');
        // TARGETDURATION 取最长的那一片（向上取整），规范要求 >= 任意 EXTINF
        const maxDur = segs.reduce((m, s) => Math.max(m, s.dur || 0), 0);
        L.push('#EXT-X-TARGETDURATION:' + Math.max(1, Math.ceil(maxDur)));
        if (segs.length) L.push('#EXT-X-MEDIA-SEQUENCE:' + (segs[0].sequence || 0));
        if (parsed.encrypted) {
            // 带密钥声明才能让播放器自己解密；IV 沿用 m3u8 里的原文
            const k = segs.find((s) => s.key && s.key.method === 'AES-128');
            if (k) {
                L.push('#EXT-X-KEY:METHOD=AES-128,URI="' + k.key.uri + '"' +
                    (k.key.iv ? ',IV=' + k.key.iv : ''));
            }
        }
        if (parsed.initSegment) {
            L.push('#EXT-X-MAP:URI="' + parsed.initSegment.url + '"');
        }
        for (const s of segs) {
            const dur = (s.dur || 0).toFixed(3).replace(/\.?0+$/, '');
            L.push('#EXTINF:' + dur + ',');
            if (s.byterange && s.byterange.length) {
                L.push('#EXT-X-BYTERANGE:' + s.byterange.length +
                    (s.byterange.offset != null ? '@' + s.byterange.offset : ''));
            }
            L.push(s.url);
        }
        L.push('#EXT-X-ENDLIST');
        L.push('');
        return L.join('\n');
    }

    // ---------- 分辨率：自定义输入与常用档位 ----------
    // 播放列表里的档位常常缺（单码率回放只有一个自动项），但用户仍可能想
    // 「按更低的分辨率下」——于是允许手填 WxH。填了之后按「不超过原始分辨率、
    // 尽量接近」的原则选最接近的档位；没有匹配就明确告知并回落自动。
    const CUSTOM_RES = '__custom__';   // 下拉里的哨兵值
    // 接受 1920x1080 / 1920X1080 / 1920×1080 / 空格 / 中文冒号
    function parseResInput(v) {
        // 归一化各种手打分隔符：中文/全角冒号（有人会打「1280：720」）、
        // 乘号、大写 X、全角 x、空格与零宽字符 —— 统一成半角 x。
        const t = String(v == null ? '' : v)
            .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角数字
            .replace(/[×╳✕]/g, 'x')
            .replace(/[：﹕]/g, 'x')
            .replace(/[XxＸｘ]/g, 'x')
            .replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
        if (!t) throw new Error('分辨率为空，格式如 1280x720');
        const m = /^(\d{2,5})x(\d{2,5})$/.exec(t);
        if (!m) throw new Error('格式不对，应为 宽x高（如 1280x720），收到：' + v);
        const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
        if (w < 16 || h < 16) throw new Error('宽高至少 16 像素，收到：' + w + 'x' + h);
        // 上限对齐脚本里 parseSpsToDims 的校验，避免下拉里塞进必然失败的选项
        if (w > 7680 || h > 4320) throw new Error('超出 7680x4320 上限，收到：' + w + 'x' + h);
        return w + 'x' + h;
    }
    // 按面积比挑最接近目标且不超过原始分辨率的档位；都不够小则返回 null
    function pickResVariant(variants, target, origW, origH) {
        const want = target.split('x');
        const tw = parseInt(want[0], 10), th = parseInt(want[1], 10);
        const targetArea = tw * th;
        let best = null, bestScore = Infinity;
        for (const v of variants || []) {
            if (!v.res) continue;
            const p = v.res.split('x');
            const w = parseInt(p[0], 10), h = parseInt(p[1], 10);
            if (!(w > 0 && h > 0)) continue;
            // 档位比原始还大 → 不是「更低的分辨率」，跳过
            if (origW && origH && (w > origW || h > origH)) continue;
            const area = w * h;
            // 惩罚：宁可略大于目标也不要远小于目标（画质损失更明显）
            const score = area >= targetArea
                ? (area - targetArea)
                : (targetArea - area) * 4;
            if (score < bestScore) { bestScore = score; best = v; }
        }
        return best;
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
        /* 检查更新：灰色小字（v1.9.4 起不再是按钮）；发现新版转为可点击的蓝色提示 */
        #dlr-panel .foot #dlr-update{cursor:pointer;color:#565b66;user-select:none;
            transition:color 150ms ease-out}
        #dlr-panel .foot #dlr-update:hover{color:#8b93a3}
        #dlr-panel .foot #dlr-update.found{color:#3d6eff}
        #dlr-panel .foot #dlr-update.found:hover{color:#6d9bff}
        /* 毛玻璃下背景半透明、会透出底层画面，页脚小字提亮 + 文字阴影保证可读 */
        #dlr-panel.frost .foot{color:#9aa1ad;text-shadow:0 1px 2px rgba(0,0,0,.8)}
        #dlr-panel.frost .foot a{color:#aab0bb;text-shadow:0 1px 2px rgba(0,0,0,.8)}
        #dlr-panel.frost .foot #dlr-update{color:#9aa1ad}
        #dlr-panel.frost .foot #dlr-update:hover{color:#cdd2db}
        #dlr-panel.frost .foot #dlr-update.found{color:#6d9bff}
        #dlr-panel.frost .foot #dlr-update.found:hover{color:#93b8ff}
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
        <div class="sec"><div class="row"><input type="text" id="dlr-url" placeholder="粘贴回放链接，或自动读取本页"></div>
            <div class="row" style="margin-top:6px">
                <textarea id="dlr-queue" rows="2" style="flex:1;resize:vertical;font:inherit;font-size:12px;
                    background:#1b1e26;color:#e6e8eb;border:1px solid #2f3440;border-radius:6px;padding:6px 8px"
                    placeholder="队列（可选）：每行一个回放，整段链接或 roomId liveUuid；按顺序依次下载"></textarea>
            </div>
            <div class="row" id="dlr-queue-ctl" style="display:none">
                <button id="dlr-queue-go" title="按队列顺序依次下载">▶ 开始队列</button>
                <button id="dlr-queue-clear" title="清空队列">✕ 清空</button>
                <span id="dlr-queue-info" class="tip" style="flex:1"></span>
            </div>
        </div>
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
        <div id="dlr-retry-row" class="row" style="display:none">
            <button id="dlr-retry" title="只重新下载上次失败的切片，其余用缓存">♻ 只重试失败切片</button>
            <span id="dlr-retry-info" class="tip" style="flex:1"></span>
        </div>
        <div class="row">
            <button id="dlr-diag" title="把版本、解析结果、失败片号、未捕获异常等导出为 .txt，便于排查问题">📋 导出诊断日志</button>
            <button id="dlr-m3u8" title="把当前选中分辨率的切片列表导出为 .m3u8，可用 VLC / ffmpeg 重新拉取">📄 导出 m3u8</button>
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
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-smart">智能调度（贪心优先 + 并发自适应）</label></div>
                <div class="row">
                    <label>面板状态</label>
                    <select id="dlr-mini-def" style="flex:1">
                        <option value="0" selected>默认展开</option>
                        <option value="1">默认收缩</option>
                    </select>
                </div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-prefetch">预取播放信息</label></div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-frost">毛玻璃</label></div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-autoupdate">自动检查更新</label></div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-notify-desktop">完成/失败时通知我</label></div>
                <div class="row"><label class="chk"><input type="checkbox" id="dlr-notify-sound">完成/失败时提示音</label></div>
                <div class="row">
                    <label>更新源</label>
                    <select id="dlr-updsrc" style="flex:1">
                        <option value="gitee">Gitee（国内推荐，默认）</option>
                        <option value="github">GitHub</option>
                        <option value="auto">自动（先 GitHub，不通再 Gitee）</option>
                    </select>
                </div>
                <div class="tip">预取播放地址与切片索引，打开页面后无需等待即可直接下载。</div>
            </div></div>
        </div>
        <div class="foot">
            <span>v<span id="dlr-ver">--</span></span>
            <span id="dlr-update" title="检查更新；发现新版后点击跳转下载页">检查更新</span>
            <span style="color:#3a3f4b">·</span>
            <span>By</span>
            <a href="https://github.com/Vectg" target="_blank" rel="noopener noreferrer">@Vectg</a>
        </div>
        </div>
        </div>
    `;

    function parseUrl(url) {
        let u;
        try { u = new URL(url.trim()); }
        catch (e) { u = new URL('https://x/?' + url.trim().replace(/^[?#]+/, '')); }
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

        // 控制行：只留倍速。音量不单独做滑块——原生 controls 里已经有音量按钮，
        // 再加一个只是重复操作，还占掉面板宽度。
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
        const cap = document.createElement('div');
        cap.className = 'pn';
        cap.textContent = '预览：' + name;
        ctl.appendChild(cap);
        ctl.appendChild(sp);
        box.appendChild(ctl);

        close.addEventListener('click', () => {
            try { URL.revokeObjectURL(v.src); } catch (e) {}
            box.innerHTML = '';
            box.style.display = 'none';
        });
        box.style.display = 'block';
    }

    // ---------- 下载控制：暂停 / 继续 / 中断 / 删除已下载 ----------
    // DL 跨 run 存活；partial 保存已下载切片实现「中断再下 = 断点续传」。
    // partial.failed 记录上次失败的片号与原因，用于「只重试失败切片」的提示文案
    // 与「换更低并发重试」建议——好片永远留在 datas 里，不会被重复下载。
    const DL = { pause: false, cancel: false, running: false, purge: false };
    let partial = null;   // {key, datas} —— 中断时保留，purge 时清空
    // 上次失败的片号（1-based）。为 null 表示没有待重试的失败片，按钮隐藏。
    // 成功/换 key/删除缓存时清空——避免拿上一轮的数字误导用户。
    let lastFailed = null;

    // ---------- IndexedDB 断点缓存：跨刷新/关页保留已下载切片 ----------
    // 单槽记录 {key, at, datas}：datas 与切片一一对应（未下载为 null）。
    // 内存 partial 是快路径，IndexedDB 是刷新后的兜底；隐私模式等不可用时
    // 静默退化为仅内存缓存，不影响下载主流程。
    const IDB_NAME = 'dlr-replay-cache', IDB_STORE = 'slices', IDB_SLOT = 'current';
    let idbDb = null, idbBroken = false;
    function idbOpen() {
        if (idbBroken) return Promise.resolve(null);
        if (idbDb) return Promise.resolve(idbDb);
        return new Promise((res) => {
            try {
                const req = indexedDB.open(IDB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
                req.onsuccess = () => { idbDb = req.result; res(idbDb); };
                req.onerror = () => { idbBroken = true; res(null); };
                req.onblocked = () => { idbBroken = true; res(null); };
            } catch (e) { idbBroken = true; res(null); }
        });
    }
    // 稀疏数组转稠密（未下载=null），否则结构化克隆会丢洞位
    async function idbPutPartial(key, datas) {
        const db = await idbOpen();
        if (!db) return false;
        const dense = Array.from({ length: datas.length }, (_, i) => datas[i] || null);
        return new Promise((res) => {
            try {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put({ key, at: Date.now(), datas: dense }, IDB_SLOT);
                tx.oncomplete = () => res(true);
                tx.onerror = () => res(false);
                tx.onabort = () => res(false);
            } catch (e) { res(false); }
        });
    }
    async function idbGetPartial() {
        const db = await idbOpen();
        if (!db) return null;
        return new Promise((res) => {
            try {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const rq = tx.objectStore(IDB_STORE).get(IDB_SLOT);
                rq.onsuccess = () => res(rq.result || null);
                rq.onerror = () => res(null);
            } catch (e) { res(null); }
        });
    }
    async function idbClearPartial() {
        const db = await idbOpen();
        if (!db) return false;
        return new Promise((res) => {
            try {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(IDB_SLOT);
                tx.oncomplete = () => res(true);
                tx.onerror = () => res(false);
                tx.onabort = () => res(false);
            } catch (e) { res(false); }
        });
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
        DL.running = true; DL.pause = false; DL.cancel = false;
        const ctl = $('dlr-ctl'); if (ctl) ctl.style.display = 'flex';
        const pb = $('dlr-pause'); if (pb) pb.textContent = '⏸ 暂停';
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
        DL.running = false; DL.pause = false; DL.cancel = false; DL.purge = false;
        const ctl = $('dlr-ctl'); if (ctl) ctl.style.display = 'none';
        const pb = $('dlr-pause'); if (pb) pb.textContent = '⏸ 暂停';
        if (!p) return;
        if (ok) {
            progressSet(100, '完成');
            p.classList.add('done');
        } else {
            p.classList.remove('on');
        }
    }

    // ---------- 原始分辨率自动分析：TS 解包 → H.264 SPS ----------
    // 真实回放是单档 TS（无 STREAM-INF 变体），分辨率只能从切片内 SPS 读出。
    // 已用真实切片验证：1280×720 Main@3.1。
    function parseSpsToDims(nal) {
        let bit = 0;
        const maxBit = nal.length * 8;
        const getBit = () => {
            if (bit >= maxBit) throw new Error('SPS 越界');
            const v = (nal[bit >> 3] >> (7 - (bit & 7))) & 1;
            bit++;
            return v;
            };
        const getBits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | getBit(); return v; };
        const ue = () => { let z = 0; while (getBit() === 0) z++; if (z > 31) throw new Error('ue 异常'); return (1 << z) - 1 + getBits(z); };
        const se = () => { const v = ue(); return (v & 1) ? (v + 1) / 2 : -(v / 2); };

        bit = 8;                                    // 跳 NAL header（nal[0] 必须是 0x67）
        const profileIdc = getBits(8);
        getBits(8);                                 // constraint flags + reserved
        const levelIdc = getBits(8);
        ue();                                       // seq_parameter_set_id
        let chromaFormatIdc = 1;
        if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profileIdc) >= 0) {
            chromaFormatIdc = ue();
            if (chromaFormatIdc === 3) getBit();
            ue(); ue(); getBit();
            if (getBit()) {                         // seq_scaling_matrix_present
                const n = chromaFormatIdc !== 3 ? 8 : 12;
                for (let i = 0; i < n; i++) {
                    if (getBit()) {
                        let next = 8;
                        const size = i < 6 ? 16 : 64;
                        for (let j = 0; j < size; j++) {
                            if (next !== 0) { const d = se(); next = (next + d + 256) % 256; }
                        }
                    }
                }
            }
        }
        ue();                                       // log2_max_frame_num_minus4
        const pocType = ue();
        if (pocType === 0) ue();
        else if (pocType === 1) { getBit(); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
        ue(); getBit();                             // max_num_ref_frames, gaps_in_frame_num
        const picWidthInMbs = ue() + 1;
        const picHeightInMapUnits = ue() + 1;
        const frameMbsOnly = getBit();
        if (!frameMbsOnly) getBit();
        getBit();                                   // direct_8x8_inference
        let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
        if (getBit()) { cropL = ue(); cropR = ue(); cropT = ue(); cropB = ue(); }
        const subWidthC = (chromaFormatIdc === 1 || chromaFormatIdc === 2) ? 2 : 1;
        const subHeightC = (chromaFormatIdc === 1) ? 2 : 1;
        const cropUnitX = (chromaFormatIdc === 0) ? 1 : subWidthC;
        const cropUnitY = (chromaFormatIdc === 0) ? (2 - frameMbsOnly) : subHeightC * (2 - frameMbsOnly);
        const width = picWidthInMbs * 16 - (cropL + cropR) * cropUnitX;
        const height = (2 - frameMbsOnly) * picHeightInMapUnits * 16 - (cropT + cropB) * cropUnitY;
        if (!(width > 0 && height > 0 && width <= 7680 && height <= 4320)) throw new Error('分辨率越界 ' + width + 'x' + height);
        return { width, height, profileIdc, levelIdc };
    }

    // TS → PES payload → Annex B，收集 type=7(SPS) 候选（b 指向 NAL header）
    function findSpsCandidates(buf) {
        const pes = [];
        for (let off = 0; off + 188 <= buf.length; off++) {
            if (buf[off] !== 0x47) continue;
            const pusi = (buf[off + 1] & 0x40) !== 0;
            const afc = (buf[off + 3] >> 4) & 0x3;
            let payload = off + 4;
            if (afc === 2 || afc === 3) payload = off + 5 + buf[off + 4];
            if (afc === 0 || payload >= off + 188) { off += 187; continue; }
            if (pusi) pes.push(-1);
            for (let i = payload; i < off + 188; i++) pes.push(buf[i]);
            off += 187;
        }
        const p = Uint8Array.from(pes.filter((x) => x >= 0));
        let s = -1;
        for (let i = 0; i + 4 < p.length; i++) {
            if (p[i] === 0 && p[i + 1] === 0 && p[i + 2] === 1 && p[i + 3] >= 0xE0 && p[i + 3] <= 0xEF) {
                const hdrLen = p[i + 6];
                s = i + 9 + hdrLen;
                break;
            }
        }
        if (s < 0) return [];
        const starts = [];
        for (let i = s; i + 4 < p.length; i++) {
            if (p[i] === 0 && p[i + 1] === 0 && p[i + 2] === 1) { starts.push({ t: p[i + 3] & 0x1F, b: i + 3 }); i += 3; }
            else if (p[i] === 0 && p[i + 1] === 0 && p[i + 2] === 0 && p[i + 3] === 1) { starts.push({ t: p[i + 4] & 0x1F, b: i + 4 }); i += 4; }
        }
        const hits = [];
        for (let k = 0; k < starts.length; k++) {
            if (starts[k].t !== 7) continue;
            let end = p.length;
            for (let j = starts[k].b; j + 4 < p.length; j++) {
                if (p[j] === 0 && p[j + 1] === 0 && p[j + 2] <= 1) { end = j; break; }
            }
            hits.push(p.subarray(starts[k].b, end));
        }
        return hits;
    }

    async function probeResolution(segUrl) {
        const r = await gmx({ url: segUrl, binary: true, headers: { Range: 'bytes=0-65535' } });
        const buf = new Uint8Array(r.response);
        if (buf[0] !== 0x47) return null;           // 非 TS（fMP4 等）不探测
        for (const nal of findSpsCandidates(buf)) {
            try {
                if (nal[0] === 0x67) return parseSpsToDims(nal);
            } catch (e) { /* 尝试下一个候选 */ }
        }
        return null;
    }

    // 体积预估：Range 只拉首片 1 字节读 Content-Range 得单片总大小，不下载整片
    async function probeSegBytes(url) {
        try {
            const r = await gmx({ url, binary: true, headers: { Range: 'bytes=0-0' } });
            const hdr = String(r.responseHeaders || '');
            let m = hdr.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
            if (m) return parseInt(m[1], 10);
            m = hdr.match(/content-length:\s*(\d+)/i);
            if (m) return parseInt(m[1], 10);
        } catch (e) { /* 预估失败不影响下载 */ }
        return null;
    }

    // 抽样探测多片体积，给贪心调度用。
    // 只探头部与尾部若干片（1 字节 Range，不下载整片）：HLS 切片体积通常只有
    // 码率波动造成的轻微差异，抽样足够反映「谁更大」；全量探测反而拖慢启动。
    // 关键：BYTERANGE 分片的 content-range 反映的是整个文件而非这一段，
    // 对它们返回 null（贪心退回原序），别拿错的体积做决策。
    async function probeSegSizes(segs, sample) {
        const n = segs.length;
        if (!n) return null;
        const want = Math.max(2, sample || 6);
        // 头部 3 片 + 尾部 3 片，不重叠；片数少时全探
        const picks = [];
        if (n <= want) {
            for (let i = 0; i < n; i++) picks.push(i);
        } else {
            const half = Math.max(1, Math.floor(want / 2));
            for (let i = 0; i < half; i++) picks.push(i);
            for (let i = n - (want - half); i < n; i++) picks.push(i);
        }
        const sizes = new Array(n).fill(null);
        let got = 0;
        const CONC = Math.min(4, picks.length);
        let cursor = 0;
        await Promise.all(Array.from({ length: CONC }, async () => {
            while (cursor < picks.length) {
                const i = picks[cursor++];
                const sg = segs[i];
                if (!sg || (sg.byterange && sg.byterange.length)) continue;
                try {
                    const r = await gmx({ url: sg.url, binary: true, headers: { Range: 'bytes=0-0' } });
                    const hdr = String(r.responseHeaders || '');
                    const m = hdr.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i)
                        || hdr.match(/content-length:\s*(\d+)/i);
                    const v = m ? parseInt(m[1], 10) : null;
                    if (v > 0) { sizes[i] = v; got++; }
                } catch (e) { /* 单片探测失败不影响整体 */ }
            }
        }));
        return got >= 2 ? sizes : null;
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
        // 单档 TS → 探测首片 SPS 得出原始分辨率（多档时分辨率来自变体 RESOLUTION 属性）
        let resInfo = null;
        if (!parsed.variants.length && !parsed.fmp4 && parsed.segments.length) {
            try {
                resInfo = await probeResolution(parsed.segments[0].url);
                if (resInfo) {
                    const profiles = { 77: 'Main', 66: 'Baseline', 100: 'High' };
                    const profile = profiles[resInfo.profileIdc] || ('profile ' + resInfo.profileIdc);
                    appendLog('   原始分辨率 ' + resInfo.width + '×' + resInfo.height +
                        '（H.264 ' + profile + ' @' + (resInfo.levelIdc / 10).toFixed(1) + '）');
                }
            } catch (e) { appendLog('   ⚠ 分辨率探测失败: ' + e.message); }
        }
        prepCache = { key, at: Date.now(), token, model, parsed, resInfo };
        return prepCache;
    }

    // ---------- 智能调度：贪心优先级 + 自适应并发 ----------
    // 为什么要调度而不是顺序取：HLS 切片时长不完全相等，而且「谁先下完」决定了
    // 尾部长度。贪心策略——优先下体积最大的切片，让「最长的那根线」尽早启动，
    // 整体完成时间由最慢的一片决定，先啃硬骨头能把尾部压缩下来。
    // 自适应并发：并发开太高会互相抢带宽甚至被 CDN 限流，全低又浪费时间。
    // 做法是滑动窗口测速——连续若干次成功且速度没有崩，就加一个线程；
    // 一旦出现失败或速度骤降，先减线程再重试。
    const SMART = { enabled: true, min: 1, max: 16 };

    // 构造贪心取片顺序：体积大的优先，同体积按原序（保证可复现）。
    // sizes 缺失（未知体积）时按原序排，不要因为缺数据就打乱。
    function greedyOrder(sizes, skip) {
        const n = sizes.length;
        const idx = [];
        for (let i = 0; i < n; i++) {
            if (skip && skip[i]) continue;      // 已在断点缓存里的片跳过
            idx.push(i);
        }
        idx.sort((a, b) => {
            const sa = sizes[a], sb = sizes[b];
            const ha = typeof sa === 'number' && sa > 0;
            const hb = typeof sb === 'number' && sb > 0;
            if (ha && hb && sb !== sa) return sb - sa;   // 大的在前
            if (ha !== hb) return ha ? -1 : 1;           // 已知体积优先于未知
            return a - b;                                  // 同类按原序，稳定
        });
        return idx;
    }

    // 自适应并发控制器。每完成/失败一片调用一次 note()，返回当前建议并发。
    // 设计成纯计数器 + 回调，便于在测试里脱离网络单独验证行为。
    function makeConcurrencyGovernor(opts) {
        const min = Math.max(1, opts.min || 1);
        const max = Math.max(min, opts.max || 16);
        let cur = Math.max(min, Math.min(max, opts.start || min));
        let winDone = 0, winBytes = 0, winMs = 0;
        let lastSpeed = 0;
        const WINDOW = opts.window || 6;        // 每 6 片结算一次
        const WIN_MS = opts.winMs || 4000;     // 或每 4 秒结算一次
        let firstT = 0;

        return {
            get value() { return cur; },
            // 成功一片：把它的字节数记进窗口，窗口满则尝试加一个线程。
            // 速度由累计字节/窗口时长算，不看单片瞬时值——瞬时值噪声太大，
            // 一片 3MB/0.2s 和一片 10KB/0.01s 都可能只是 CDN 抖动。
            note(size, speedBps) {
                const now = Date.now();
                if (!firstT) firstT = now;
                winDone++;
                winBytes += (typeof size === 'number' && size > 0) ? size : 0;
                winMs = now - firstT;
                if (speedBps) lastSpeed = speedBps;
                // 结算条件用「片数窗口」为准、时间为辅。只靠时间在极快网络下
                // 会在同一毫秒内算不出平均速度，导致并发永远不涨。
                if (winDone >= WINDOW || winMs >= WIN_MS) {
                    const avg = winMs > 0 ? winBytes / (winMs / 1000) : winBytes / WINDOW;
                    if (avg > 0 && cur < max) cur++;
                    winDone = 0; winBytes = 0; winMs = 0; firstT = now;
                }
                return cur;
            },
            // 失败一片：立刻降并发（先退避再重试，别继续硬打）。
            // 注意 winFail 的生命周期——它只该影响「当前这一个窗口」。
            // 早先的实现里 winFail 一旦置 1 就再没被清过（结算时才清，
            // 但结算被 winFail===0 卡住，形成死锁），结果一次失败之后
            // 并发永远涨不回来。现在：降并发 + 重开窗口，但不置抑制标记，
            // 因为「降并发」本身就是这次失败带来的惩罚，不需要再叠一层。
            fail() {
                if (cur > min) cur--;
                winDone = 0; winBytes = 0; winMs = 0; firstT = 0;
                return cur;
            },
            stats() { return { cur, min, max, lastSpeed }; },
        };
    }

    // ---------- 下载队列：多个回放顺序执行 ----------
    // 设计取向：run() 一行不改，队列只做外层调度。这样「单次回放」的行为与
    // 1.9.x 完全一致，出问题也只需怀疑队列本身。
    // 为什么顺序执行而不是并发：并发多个回放会让总带宽争抢，
    // 反而把每个都拖慢；用户要的是「一次挂几个」，不是「一起抢带宽」。
    const Q = {
        items: [],        // {id, roomId, liveUuid, opts, title}
        running: false,   // 队列调度器是否在跑
        current: -1,      // 当前执行中的下标
    };
    let queueSeq = 0;
    // run() 内部 catch 掉所有异常并写状态栏，不向外抛——队列调度器无法靠
    // try/catch 判定成败，只能读这个由 run() 显式回写的标志。
    let lastRunResult = { ok: false, name: '' };

    // 解析一行输入 → 一个任务。支持整段 URL、roomId/liveUuid 对、纯 liveUuid。
    // 失败要指出是哪一行，不能只说「格式错误」。
    function parseQueueLine(line, label) {
        const raw = String(line == null ? '' : line).trim();
        if (!raw) throw new Error(label + '为空');
        // 整段 URL（或带 ? 的裸查询串）→ 交给 parseUrl 拆参数
        if (raw.includes('?') || raw.includes('roomId=')) {
            return parseUrl(raw);
        }
        // roomId 与 liveUuid 用空白/逗号/分号分隔
        const parts = raw.split(/[\s,;]+/).filter(Boolean);
        // 带标签的写法要同时支持 "roomId x liveUuid y" 和 "roomId=x liveUuid=y"
        // ——从钉钉或聊天记录里复制出来时，等号形式很常见。
        const tagged = { roomId: '', liveUuid: '' };
        for (const p of parts) {
            const m = /^roomid\s*=\s*(.+)$/i.exec(p);
            if (m) { tagged.roomId = m[1]; continue; }
            const u = /^liveuuid\s*=\s*(.+)$/i.exec(p);
            if (u) { tagged.liveUuid = u[1]; continue; }
            const lb = /^roomid$/i.test(p), lu = /^liveuuid$/i.test(p);
            if (lb || lu) {
                const idx = parts.indexOf(p);
                if (parts[idx + 1]) {
                    if (lb) tagged.roomId = parts[idx + 1];
                    else tagged.liveUuid = parts[idx + 1];
                }
            }
        }
        if (tagged.roomId && tagged.liveUuid) return { roomId: tagged.roomId, liveUuid: tagged.liveUuid };
        if (parts.length >= 2) return { roomId: parts[0], liveUuid: parts[1] };
        // 只给了一个值：当作 liveUuid（多数人复制分享链接时先拿到的是这个）
        if (/^[0-9a-fA-F-]{16,}$/.test(parts[0])) return { roomId: '', liveUuid: parts[0] };
        throw new Error(label + '格式不对：需要整段回放链接，或「roomId liveUuid」一对');
    }

    // 从多行文本解析出任务列表。空行与 # 开头的行忽略。
    function parseQueueInput(text) {
        const lines = String(text == null ? '' : text).split(/\r?\n/);
        const out = [];
        const errs = [];
        lines.forEach((ln, i) => {
            const raw = ln.trim();
            if (!raw || raw.startsWith('#')) return;
            try {
                const r = parseQueueLine(raw, '第 ' + (i + 1) + ' 行');
                out.push({ roomId: r.roomId, liveUuid: r.liveUuid });
            } catch (e) {
                errs.push(e.message);
            }
        });
        return { out, errs };
    }

    async function run(roomId, liveUuid, opts) {
        lastRunResult = { ok: false, name: '' };   // 每次调用先清空，防读到上次的残留
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
            // 体积预估：Range 拉首片 1 字节读 Content-Range → 单片 × 片数
            let estTotal = null, segSizes = null;
            if (segs.length) {
                try {
                    const one = await probeSegBytes(segs[0].url);
                    if (one > 0) {
                        estTotal = one * segs.length;
                        appendLog('   预计体积: 约 ' + fmtBytes(estTotal) +
                            '（单片 ' + fmtBytes(one) + ' × ' + segs.length + ' 片）');
                    }
                } catch (e) { /* 预估失败静默 */ }
            }
            // 抽样探测各片真实体积，供贪心调度排序（探不到就退回原序，不影响下载）
            if (segs.length >= 4) {
                try { segSizes = await probeSegSizes(segs, 6); } catch (e) { segSizes = null; }
            }
            progressSet(P.dlStart, '下载');
            setPhase('download');   // 进入下载阶段：收缩条转绿

            appendLog('④ 下载切片（并发 ' + opts.threads + '，重试 ' + opts.retry + '）...');
            const datas = new Array(segs.length);
            // 断点续传：命中同 key 的 partial 缓存则直接复用已下载切片
            const dlKey = roomId + '|' + liveUuid + '|' + (opts.res || '') +
                '|' + (clip.range ? clip.range.from + '-' + clip.range.to : 'full');
            let resumed = 0, resumedBytes = 0;
            if (partial && partial.key === dlKey &&
                partial.datas && partial.datas.length === segs.length) {
                for (let i = 0; i < segs.length; i++) {
                    if (partial.datas[i]) { datas[i] = partial.datas[i]; resumed++; resumedBytes += datas[i].length; }
                }
                if (resumed) {
                    appendLog('   ♻ 命中断点缓存，已恢复 ' + resumed + '/' + segs.length + ' 个切片');
                    // 上次留下的失败片号（若有）继续沿用，让「只重试」按钮跨轮次保持可见
                    const stillMissing = [];
                    for (let i = 0; i < segs.length; i++) if (!datas[i]) stillMissing.push(i + 1);
                    lastFailed = stillMissing.length ? stillMissing : null;
                }
            }
            // 内存没命中 → 查 IndexedDB（跨刷新/关页后仍在）
            if (!resumed) {
                try {
                    const saved = await idbGetPartial();
                    if (saved && saved.key === dlKey &&
                        saved.datas && saved.datas.length === segs.length) {
                        for (let i = 0; i < segs.length; i++) {
                            if (saved.datas[i]) { datas[i] = saved.datas[i]; resumed++; resumedBytes += datas[i].length; }
                        }
                        if (resumed) {
                            partial = { key: dlKey, datas: datas.slice() };
                            // IDB 里没存 failed 清单，但「哪些片缺失」可以自己算出来
                            const missing = [];
                            for (let i = 0; i < segs.length; i++) if (!datas[i]) missing.push(i + 1);
                            lastFailed = missing.length ? missing : null;
                            appendLog('   ♻ 命中跨会话断点缓存（IndexedDB），已恢复 ' +
                                resumed + '/' + segs.length + ' 个切片');
                        }
                    }
                } catch (e) { /* IDB 不可用则静默走全新下载 */ }
            }
            const failures = [];   // {index, url, reason}
            let cursor = 0, done = resumed;
            let active = 0;         // 当前在途的切片请求数（自适应并发的依据）
            const keyCache = new Map();
            const span = P.dlEnd - P.dlStart;
            // 速度（EMA 平滑）+ 预计剩余时间
            let speedBps = 0, lastTickT = Date.now(), lastTickBytes = 0, gotBytes = 0;
            let haveBytes = resumedBytes;   // 已持有字节（含断点恢复），进度条体积显示用
            const fmtSpeed = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/s'
                : (b >= 1024 ? Math.round(b / 1024) + ' KB/s' : Math.round(b) + ' B/s');
            const updProgress = () => {
                const now = Date.now(), dt = (now - lastTickT) / 1000;
                if (dt >= 1) {
                    const inst = (gotBytes - lastTickBytes) / dt;
                    speedBps = speedBps ? speedBps * 0.6 + inst * 0.4 : inst;
                    lastTickT = now; lastTickBytes = gotBytes;
                }
                const remain = segs.length - done;
                const avg = done ? gotBytes / (done - resumed) || 0 : 0;
                const eta = (speedBps > 0 && avg > 0) ? Math.round((avg * remain) / speedBps) : null;
                let label = '切片 ' + done + '/' + segs.length;
                if (estTotal) label += ' · ' + fmtBytes(haveBytes) + '/' + fmtBytes(estTotal);
                if (speedBps > 0) label += ' · ' + fmtSpeed(speedBps);
                if (eta !== null && eta >= 0 && remain > 0) label += ' · 剩 ' + fmtTime(eta);
                if (DL.pause) label += ' · 已暂停';
                progressSet(P.dlStart + (done / segs.length) * span, label);
            };

            // 智能调度：贪心取片顺序 + 自适应并发。
            // 切片体积未知时（探测失败）greedyOrder 会退回原序，不会打乱下载。
            // 开关状态每次下载时读一次（用户可能在下载中途改）
            let smartOn = SMART.enabled;
            try {
                const v = GM_getValue('dlr_smart');
                if (v !== undefined && v !== null) smartOn = !!v;
            } catch (e) { }
            const useSmart = smartOn && SMART.max > SMART.min;
            let order = null;
            if (useSmart) {
                // 优先用抽样探测到的真实体积；抽不出来就退回原序
                const sizes = segSizes && segSizes.some((x) => x > 0) ? segSizes : segs.map(() => null);
                const known = sizes.filter((x) => x > 0).length;
                order = greedyOrder(sizes, datas);
                if (known) {
                    const mx = Math.max.apply(null, sizes.filter((x) => x > 0));
                    const mn = Math.min.apply(null, sizes.filter((x) => x > 0));
                    appendLog('   调度：贪心优先下大切片（已抽样 ' + known + '/' + segs.length +
                        ' 片，' + fmtBytes(mn) + '~' + fmtBytes(mx) + '），并发 ' +
                        SMART.min + '~' + SMART.max + ' 自适应');
                } else {
                    appendLog('   调度：切片体积未知，按原序下载，并发自适应 ' + SMART.min + '~' + SMART.max);
                }
            }
            let oCursor = 0;
            const gov = useSmart ? makeConcurrencyGovernor({
                min: SMART.min, max: SMART.max,
                start: Math.max(SMART.min, Math.min(SMART.max, opts.threads)),
            }) : null;
            // 活跃 worker 数的上限由 gov 动态控制；关掉智能调度时固定为用户设定值
            const MAXW = useSmart ? SMART.max : opts.threads;

            const worker = async () => {
                while (true) {
                    if (DL.cancel) return;
                    // 暂停：原地等待，恢复后继续取下一片
                    while (DL.pause && !DL.cancel) await new Promise((r) => setTimeout(r, 120));
                    if (DL.cancel) return;
                    // 自适应并发：活跃数超过当前建议就原地等，别硬抢
                    if (gov && active >= gov.value) {
                        await new Promise((r) => setTimeout(r, 60));
                        continue;
                    }
                    let i;
                    if (order) {
                        if (oCursor >= order.length) return;
                        i = order[oCursor++];
                    } else {
                        if (cursor >= segs.length) return;
                        i = cursor++;
                        // 跳过断点缓存里已有的切片
                        while (i < segs.length && datas[i]) i = cursor++;
                    }
                    if (i >= segs.length) return;
                    const seg = segs[i];
                    if (!seg) return;
                    active++;
                    let lastErr = null;
                    for (let t = 0; t < opts.retry; t++) {
                        if (DL.cancel) { active--; return; }
                        while (DL.pause && !DL.cancel) await new Promise((r) => setTimeout(r, 120));
                        if (DL.cancel) { active--; return; }
                        try {
                            const got = await downloadSegment(seg, keyCache, 0);
                            datas[i] = got.bytes;
                            gotBytes += got.bytes.length;
                            haveBytes += got.bytes.length;
                            done++;
                            if (gov) gov.note(got.bytes.length);
                            updProgress();
                            if (done % 10 === 0 || done === segs.length) appendLog('   ' + done + '/' + segs.length);
                            lastErr = null;
                            break;
                        } catch (e) {
                            lastErr = e;
                            if (gov) gov.fail();
                            // 指数退避，避免瞬时失败时立刻重试打爆 CDN
                            if (t < opts.retry - 1) await new Promise((r) => setTimeout(r, 400 * (t + 1)));
                        }
                    }
                    active--;
                    if (lastErr) failures.push({ index: i + 1, url: seg.url, reason: lastErr.message });
                }
            };
            await Promise.all(Array.from({ length: MAXW }, worker));
            if (gov) {
                appendLog('   调度结束：并发收敛于 ' + gov.value +
                    (gov.stats().lastSpeed ? '，末速约 ' + fmtBytes(gov.stats().lastSpeed) + '/s' : ''));
            }

            // 中断/删除：保留（或清空）已下载切片供下次续传，本次不算失败
            if (DL.cancel) {
                const gotCount = datas.filter(Boolean).length;
                if (DL.purge) {
                    partial = null;
                    lastFailed = null;
                    try { await idbClearPartial(); } catch (e) { }
                    setStatus('🗑 已删除全部下载缓存（' + gotCount + ' 片已放弃），点下载将重新开始。');
                } else {
                    partial = { key: dlKey, datas: datas.slice() };
                    // 落盘 IndexedDB：刷新/关页后仍可断点续传
                    let persisted = false;
                    try { persisted = await idbPutPartial(dlKey, datas); } catch (e) { }
                    setStatus('⏹ 已中断：已下载 ' + done + '/' + segs.length +
                        (persisted ? '（已缓存到本地，刷新后仍可断点续传）'
                                   : '（已缓存，点「下载本页回放」断点续传）'));
                }
                progressDone(false);
                return;
            }

            // 失败诊断：单行模式，压成一条总结 + 建议（合并进最终错误消息）
            if (failures.length) {
                const first = failures[0];
                const allAuth = failures.every((f) => /HTTP (401|403)/.test(f.reason));
                const all404 = failures.every((f) => /HTTP 404/.test(f.reason));
                let advice;
                if (allAuth) advice = '多为 auth_key 签名过期（约 10 天有效），刷新页面重新获取链接';
                else if (all404) advice = '切片已过期或被清理，回放可能已失效';
                else advice = '可降低并发线程数后重试，或点「检查更新」确认脚本为最新版';
                // 好片留存为断点缓存 + 记下失败片号：下次点下载只补这几片
                partial = { key: dlKey, datas: datas.slice(), failed: failures.slice() };
                lastFailed = failures.map((f) => f.index);
                try { await idbPutPartial(dlKey, datas); } catch (e) { }
                appendLog('❌ ' + failures.length + '/' + segs.length + ' 切片失败：#' + first.index + ' ' + first.reason);
                appendLog('   好片 ' + (segs.length - failures.length) + ' 片已保留为断点缓存，' +
                    '点「下载本页回放」只重试这 ' + failures.length + ' 片');
                throw new Error(failures.length + '/' + segs.length + ' 切片失败（#' + first.index + ' ' + first.reason + '）。建议：' + advice);
            }
            // 完整性校验：数量齐全、非空、TS 同步字节对齐（fMP4 不适用）。
            // 不硬性要求 d[0]===0x47——真实切片可能带 ID3/填充前缀（probeResolution
            // 就是扫描找对齐的），改为在首 188 字节内找对齐点并验证 188 周期性：
            // HTML 错误页/截断数据找不到周期性 → 判异常；带前缀的合法切片能通过。
            const looksLikeTs = (d) => {
                if (d.length < 188) return true;   // 过短无法判型，只保证非空
                const maxOff = Math.min(188, d.length);
                for (let off = 0; off < maxOff; off++) {
                    if (d[off] !== 0x47) continue;
                    let k = 1, ok = true;
                    while (off + k * 188 < d.length && k < 8) {
                        if (d[off + k * 188] !== 0x47) { ok = false; break; }
                        k++;
                    }
                    if (ok) return true;
                }
                return false;
            };
            const badIdx = [];
            for (let i = 0; i < segs.length; i++) {
                const d = datas[i];
                if (!d || !d.length) { badIdx.push(i + 1); datas[i] = null; continue; }
                if (!parsed.fmp4 && !looksLikeTs(d)) { badIdx.push(i + 1); datas[i] = null; }
            }
            if (badIdx.length) {
                // 问题切片置空：好片保留为断点缓存（内存+IDB），重下只补这些
                try { await idbPutPartial(dlKey, datas); } catch (e) { }
                const list = badIdx.map((i) => '#' + i).join(' ');
                partial = { key: dlKey, datas: datas.slice(), failed: badIdx.map((i) => ({
                    index: i, reason: '内容异常（空或非 TS 结构）' })) };
                lastFailed = badIdx.slice();
                appendLog('❌ 完整性校验失败：' + list + ' 内容异常（空数据或非 TS 结构）');
                throw new Error('完整性校验失败：' + list + ' 内容异常（空数据或非 TS 结构），' +
                    '其余 ' + (segs.length - badIdx.length) + '/' + segs.length +
                    ' 片已保留为断点缓存，点「下载本页回放」只补这些切片。');
            }
            const okBytes = datas.reduce((s, d) => s + (d ? d.length : 0), 0);
            appendLog('   ✅ 完整性校验通过：' + segs.length + '/' + segs.length +
                ' 片 · ' + fmtBytes(okBytes) +
                (parsed.fmp4 ? ' · fMP4' : ' · TS 同步字节正常'));
            partial = null;   // 全部下载成功，断点缓存失效
            try { await idbClearPartial(); } catch (e) { }
            lastFailed = [];

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
            diagRun(true, outName + ' · ' + fmtBytes(blob.size) + ' · ' + segs.length + ' 片');
            lastRunResult = { ok: true, name: outName };
            notify('钉钉回放下载完成', outName + ' · ' + fmtBytes(blob.size), true);
        } catch (err) {
            setStatus('❌ 失败：' + err.message, true);
            progressDone(false);
            diagRun(false, String(err.message || '').split('\n')[0],
                lastFailed && lastFailed.length ? ('待重试片号: #' + lastFailed.slice(0, 30).join(' #')) : '');
            // 失败通知正文压到一行：系统通知窗口窄，整段错误详情留给面板历史
            const brief = String(err.message || '').split('\n')[0];
            notify('钉钉回放下载失败', brief.length > 120 ? brief.slice(0, 120) + '…' : brief, false);
        } finally {
            goBtn.disabled = false;
            // 失败则亮出「只重试」按钮，成功/中断则按 lastFailed 现状刷新
            try { window.__renderRetryRow && window.__renderRetryRow(); } catch (e) { }
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
            let v = NaN;
            try { v = parseInt(GM_getValue(key), 10); } catch (e) { }
            // 读不到 / 越界 → 用默认值（自动识别结果）
            el.value = (v >= min && v <= max) ? v : def;
            el.addEventListener('change', () => {
                const n = Math.max(min, Math.min(max, parseInt(el.value, 10) || def));
                el.value = n;
                try { GM_setValue(key, n); } catch (e) { }
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
        // 并发自动识别：网络 IO 密集，按 CPU 逻辑核数 ×2 推算（4~16 封顶）；
        // 用户手动改过（dlr_thread 已持久化）则以保存值优先
        const autoThreads = Math.max(4, Math.min(16,
            (navigator.hardwareConcurrency || 4) * 2));
        bindNum('dlr-thread', 'dlr_thread', 1, 16, autoThreads);
        bindNum('dlr-retry', 'dlr_retry', 1, 10, 3);
        const thrTip = document.querySelector('#dlr-more-b .tip');
        if (thrTip) {
            thrTip.textContent = '并发已自动识别为 ' + autoThreads +
                ' 线程（CPU 核心×2，手动修改后以你的设置为准）。预取播放地址与切片索引，打开页面后无需等待即可直接下载。';
        }
        bindChk('dlr-stamp', 'dlr_stamp', false);
        const prefetch = bindChk('dlr-prefetch', 'dlr_prefetch', true);   // 自动解析：默认开启
        // 完成/失败通知：提示音默认关（浏览器自动播放策略常拦默认开的声音，
        // 让人误以为坏了），系统通知默认开（无声、可靠、点一下能回面板）
        // 智能调度：默认开启。关掉后并发固定为上面设定的线程数。
        bindChk('dlr-smart', 'dlr_smart', true);
        bindChk('dlr-notify-desktop', 'dlr_notify_desktop', true);
        bindChk('dlr-notify-sound', 'dlr_notify_sound', false);
        // 勾选变化时同步回模块级变量：notify() 在下载流程里读它们，
        // 不跟着 DOM 走，否则用户改了开关要等下次下载才生效。
        const notifyDeskChk = $('dlr-notify-desktop'), notifySndChk = $('dlr-notify-sound');
        const syncNotifyFlags = () => {
            setNotifyFlags(notifyDeskChk.checked, notifySndChk.checked);
        };
        notifyDeskChk.addEventListener('change', syncNotifyFlags);
        notifySndChk.addEventListener('change', syncNotifyFlags);
        syncNotifyFlags();

        // 分辨率：默认自动（原始=最高带宽）；预取后回填各档位，切换即重新预取
        const resSel = $('dlr-res');
        // 上一次的有效选择：用户点「自定义…」后取消/输错时要回到这里，而不是留下哨兵值
        let lastValidRes = '';
        try { const rv = GM_getValue('dlr_res'); if (rv) resSel.value = rv; } catch (e) { }
        // 常用档位：按宽度降序，实际只显示「不超过原始分辨率」的那些。
        // 播放列表里常常没有对应档位，所以这里只是快捷入口——最终仍由
        // pickResVariant 挑最接近的真实档位。
        const COMMON_RES = [
            { w: 3840, h: 2160 }, { w: 2560, h: 1440 }, { w: 1920, h: 1080 },
            { w: 1600, h: 900 }, { w: 1280, h: 720 }, { w: 960, h: 540 },
            { w: 854, h: 480 }, { w: 640, h: 360 }, { w: 480, h: 270 },
        ];
        const fillResOptions = (variants, resInfo) => {
            if (!resSel) return;
            const ow = resInfo ? resInfo.width : 0, oh = resInfo ? resInfo.height : 0;
            const cur = resSel.value;
            const autoText = resInfo
                ? '自动（原始分辨率 ' + resInfo.width + '×' + resInfo.height + '）'
                : '自动（原始分辨率）';
            resSel.innerHTML = '';
            const addOpt = (val, text) => {
                const o = document.createElement('option');
                o.value = val; o.textContent = text;
                resSel.appendChild(o);
            };
            addOpt('', autoText);

            // 播放列表声明的档位（最准确，带码率）
            const declared = (variants || []).filter((v) => v.res);
            declared.forEach((v) => {
                addOpt(v.res, v.res + ' · ' + Math.round(v.bandwidth / 1000) + ' kbps');
            });
            // 常用档位里还没出现过的（≤ 原始分辨率）也列出来，方便一键降档
            COMMON_RES.forEach((c) => {
                const key = c.w + 'x' + c.h;
                if (declared.some((v) => v.res === key)) return;
                if (ow && oh && (c.w > ow || c.h > oh)) return;   // 比原始还大，不列
                if (!ow && !oh) return;                            // 未知原始分辨率时不猜
                addOpt(key, key + (declared.length ? '（按最接近档位）' : ''));
            });
            // 自定义入口永远在最后
            addOpt(CUSTOM_RES, '自定义…（手动输入宽×高）');
            resSel.value = cur;   // 保留用户选择（不存在则回落"自动"）
        };
        resSel.addEventListener('change', () => {
            // 「自定义…」不直接用：弹输入框，校验后换成真实档位值存回去。
            // 用 prompt 而不是自造弹窗：少一份焦点/无障碍处理，浏览器原生足够。
            if (resSel.value === CUSTOM_RES) {
                const cur = (prepCache && prepCache.resInfo)
                    ? (prepCache.resInfo.width + 'x' + prepCache.resInfo.height) : '';
                let typed = '';
                try {
                    typed = window.prompt(
                        '输入想要的分辨率（宽x高），只列出不超过原始分辨率的档位：\n' +
                        '例如 1280x720', cur);
                } catch (e) { typed = null; }
                if (!typed) {          // 取消 → 回到之前的有效值
                    resSel.value = lastValidRes;
                    return;
                }
                let normalized;
                try {
                    normalized = parseResInput(typed);
                } catch (e) {
                    setStatus('❌ ' + e.message, true);
                    resSel.value = lastValidRes;
                    return;
                }
                // 解析成播放列表里真实存在的档位；没有则如实说明并回落自动
                const hit = pickResVariant(prepCache && prepCache.parsed && prepCache.parsed.variants,
                    normalized,
                    prepCache && prepCache.resInfo ? prepCache.resInfo.width : 0,
                    prepCache && prepCache.resInfo ? prepCache.resInfo.height : 0);
                if (!hit) {
                    setStatus('⚠ 没有不超过原始分辨率且接近 ' + normalized + ' 的档位，已回到「自动」', true);
                    resSel.value = '';
                    GM_setValue('dlr_res', '');
                    return;
                }
                resSel.value = hit.res;
                // 播放列表里没有正好等于输入值的档位时必须说清楚——
                // 否则用户以为下了 999x999，其实是 1280x720。
                if (hit.res !== normalized) {
                    setStatus('ℹ 播放列表里没有 ' + normalized + '，实际使用最接近的档位 ' +
                        hit.res + '（' + Math.round(hit.bandwidth / 1000) + ' kbps）');
                } else {
                    setStatus('ℹ 已选择 ' + hit.res +
                        '（' + Math.round(hit.bandwidth / 1000) + ' kbps）');
                }
            }
            lastValidRes = resSel.value;
            try { GM_setValue('dlr_res', resSel.value); } catch (e) { }
            // 切换分辨率 → 缓存键不同，直接重新预取，下载时秒用
            let p = null;
            try { p = parseUrl(($('dlr-url').value || '').trim() || location.href); } catch (e) { }
            if (p && prefetch.checked) {
                setStatus('⏳ 已切换分辨率，重新预取…');
                // 自定义档位的「实际用了哪一档」提示要留在历史里，
                // 否则会被下面这条「就绪」覆盖掉，用户就不知道自己填的值被换掉了
                const picked = resSel.value;
                prep(p.roomId, p.liveUuid, picked).then(() => {
                    if (window.__updateNameTip) window.__updateNameTip();
                    if (fillResOptions) fillResOptions(prepCache.parsed.variants, prepCache.resInfo);
                    const res = prepCache.parsed.segments.length + ' 个切片';
                    const pickedLabel = picked ? '，' + picked : '';
                    setStatus('✅ 就绪 · ' + (prepCache.model.title || '未命名') +
                        ' · ' + res + pickedLabel + '，可开始下载');
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
        const autoUpd = bindChk('dlr-autoupdate', 'dlr_autoupdate', true);   // 自动检查更新：默认开启
        // 更新源：默认 Gitee（国内可达）。改了立刻重查一次，别让用户等下次自动检查。
        const updSrcSel = $('dlr-updsrc');
        if (updSrcSel) {
            try {
                const saved = GM_getValue('dlr_updsrc');
                updSrcSel.value = (saved === 'github' || saved === 'auto') ? saved : 'gitee';
            } catch (e) { updSrcSel.value = 'gitee'; }
            updSrcSel.addEventListener('change', () => {
                try { GM_setValue('dlr_updsrc', updSrcSel.value); } catch (e) { }
                const label = updSrcSel.options[updSrcSel.selectedIndex].textContent.split('（')[0];
                setStatus('ℹ 更新源已切换为 ' + label + '，正在重新检查…');
                // 立即按新源重查一次：换源后继续拿旧源的结论没有意义。
                // remoteVersion / UPD 在下方定义，这里用 setTimeout 延到本轮之后。
                setTimeout(async () => {
                    try {
                        const v = await remoteVersion();
                        if (compareVersions(v, VERSION) > 0) {
                            showFound(v);
                            setStatus('🔄 发现新版 ' + v + '（当前 ' + VERSION + '），点击「发现新版」跳转下载页');
                        } else {
                            setStatus('✅ 已是最新版 v' + VERSION + '（更新源：' + label + '）');
                            setUpd('已是最新');
                        }
                    } catch (e) {
                        setStatus('⚠ 新更新源不可达：' + e.message, true);
                    }
                }, 0);
            });
        }

        // 版本号回填 + 检查更新（v1.9.4：灰色小字、自动检查默认开、发现新版只提示不跳转）
        $('dlr-ver').textContent = VERSION;
        const upd = $('dlr-update');
        const UPD = { busy: false, found: null, timer: 0 };
        const UPD_IDLE = '检查更新';
        const setUpd = (text, cls) => {
            upd.textContent = text;
            upd.classList.toggle('found', !!cls);
            };
        const fetchVer = (url) => new Promise((res, rej) => {
            GM_xmlhttpRequest({
                url, method: 'GET',
                onload: (r) => (r.status >= 200 && r.status < 300) ? res(r.responseText) : rej(new Error('HTTP ' + r.status)),
                onerror: () => rej(new Error('网络错误')),
                ontimeout: () => rej(new Error('超时')),
            });
        });
        // 更新源：默认 Gitee。raw.githubusercontent.com 在国内时通时不通，
        // 而 Gitee 镜像通常稳定——让用户自己选比猜更靠谱。
        //   gitee(默认) → 只查 Gitee，快且稳
        //   github      → 只查 GitHub
        //   auto        → 先 GitHub，不通回落 Gitee（旧行为）
        const UPD_ORDER = {
            gitee: [UPDATE_URL_FALLBACK, UPDATE_URL],
            github: [UPDATE_URL, UPDATE_URL_FALLBACK],
            auto: [UPDATE_URL, UPDATE_URL_FALLBACK],
        };
        const updSource = () => {
            try {
                const v = GM_getValue('dlr_updsrc');
                return UPD_ORDER[v] ? v : 'gitee';   // 默认 Gitee
            } catch (e) { return 'gitee'; }
        };
        // 跳转的下载页也跟着选：gitee 用镜像地址，github 用原地址
        const updatePageUrl = () => (updSource() === 'github' ? UPDATE_URL : UPDATE_URL_FALLBACK);
        const remoteVersion = async () => {
            const order = UPD_ORDER[updSource()];
            let txt, lastErr = null;
            for (const url of order) {
                try {
                    txt = await fetchVer(url);
                    break;
                } catch (e) { lastErr = e; }
            }
            if (txt === undefined) throw lastErr || new Error('所有更新源都不可达');
            const m = txt.match(/@version\s+(\S+)/);
            if (!m) throw new Error('无法解析远程版本号');
            return m[1];
        };
        const quietLog = (msg) => {
            const d = new Date(), p = (n) => String(n).padStart(2, '0');
            pushHistory(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '  ' + msg);
            };
        const showFound = (v) => {
            UPD.found = v;
            setUpd('发现新版 ' + v + ' ↑', true);
            upd.title = '发现新版 ' + v + '（当前 ' + VERSION + '），点击打开更新页';
            };
        // 点击：空闲=检查；已发现新版=跳转下载页；检查中=忽略
        upd.addEventListener('click', async () => {
            if (UPD.busy) return;
            if (UPD.found) {
                setStatus('🔄 已打开更新页 v' + UPD.found + '（当前 ' + VERSION + '），在油猴里确认更新即可');
                window.open(updatePageUrl(), '_blank');
                return;
            }
            clearTimeout(UPD.timer);
            UPD.busy = true;
            setUpd('检查中…');
            try {
                const v = await remoteVersion();
                if (compareVersions(v, VERSION) > 0) {
                    showFound(v);
                    setStatus('🔄 发现新版 ' + v + '（当前 ' + VERSION + '），点击「发现新版」跳转下载页');
                } else {
                    setStatus('✅ 已是最新版 v' + VERSION);
                    setUpd('已是最新');
                    UPD.timer = setTimeout(() => setUpd(UPD_IDLE), 2600);
                }
            } catch (e) {
                setStatus('❌ 检查更新失败：' + e.message, true);
                setUpd('失败');
                UPD.timer = setTimeout(() => setUpd(UPD_IDLE), 2600);
            } finally {
                UPD.busy = false;
                upd.title = UPD.found
                    ? ('发现新版 ' + UPD.found + '，点击打开更新页')
                    : '检查更新；发现新版后点击跳转下载页';
            }
        });
        // 自动检查（默认开启，可在更多设置关闭）：只把角标变成「发现新版」，
        // 不跳转、不打扰状态栏；关闭后仍可点「检查更新」手动比对再决定是否跳转
        if (autoUpd.checked) {
            setTimeout(async () => {
                if (UPD.busy || UPD.found) return;
                UPD.busy = true;
                try {
                    const v = await remoteVersion();
                    if (compareVersions(v, VERSION) > 0) {
                        showFound(v);
                        quietLog('🔄 自动检查：发现新版 ' + v + '（当前 ' + VERSION + '），点击「发现新版」跳转下载页');
                    } else {
                        quietLog('检查更新：已是最新版 v' + VERSION);
                    }
                } catch (e) {
                    quietLog('检查更新（自动）失败：' + e.message);
                } finally {
                    UPD.busy = false;
                }
            }, 1600);
        }

        // 收缩 / 展开：不用时缩成一个小图标，状态持久化
        // 宽度/内边距/圆角为定值可直接补间；内容用 opacity 淡出，高度随内容塌缩
        const applyMini = () => panel.classList.toggle('mini', miniState);
        // 归一化：'1'/1/true/'true' = 收缩，'0'/0/false/'false' = 展开，缺省 = 展开。
        // 历史上 dlr_mini 存过布尔/字符串、dlr_mini_def 存过数字，严格 === 会漏判，
        // 导致「面板实际收缩、下拉框却显示默认展开」。
        const triState = (v) => (v === '1' || v === 1 || v === true || v === 'true') ? 1
            : (v === '0' || v === 0 || v === false || v === 'false') ? 0 : -1;
        let miniState = false;
        try {
            // 优先「默认面板状态」，缺失/无法识别时回退旧键 dlr_mini
            let t = triState(GM_getValue('dlr_mini_def'));
            if (t < 0) t = triState(GM_getValue('dlr_mini'));
            miniState = t === 1;
            // 归一回写：杂散值统一成规范 '0'/'1' 与布尔，兼容分支只在首启走一次
            const canon = miniState ? '1' : '0';
            if (GM_getValue('dlr_mini_def') !== canon) GM_setValue('dlr_mini_def', canon);
            if (GM_getValue('dlr_mini') !== miniState) GM_setValue('dlr_mini', miniState);
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
        // 下拉框直接反映上面算出的真实初始状态（与面板同源），不再自己另读一遍键
        try { if (miniDef) miniDef.value = miniState ? '1' : '0'; } catch (e) { }
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

        // 下载控制：暂停/继续、中断、删除已下载
        const pauseBtn = $('dlr-pause');
        pauseBtn && pauseBtn.addEventListener('click', () => {
            if (!DL.running) return;
            DL.pause = !DL.pause;
            pauseBtn.textContent = DL.pause ? '▶ 继续' : '⏸ 暂停';
            setStatus(DL.pause ? '⏸ 已暂停：进度已保留，点「▶ 继续」恢复下载'
                              : '▶ 继续下载中…');
        });
        const cancelBtn = $('dlr-cancel');
        cancelBtn && cancelBtn.addEventListener('click', () => {
            if (!DL.running) return;
            DL.cancel = true;
            setStatus('⏹ 正在停止…（已下载切片会保留，可断点续传）');
        });
        const purgeBtn = $('dlr-purge');
        purgeBtn && purgeBtn.addEventListener('click', () => {
            if (DL.running) {
                DL.purge = true;
                DL.cancel = true;
                setStatus('🗑 正在清空全部已下载切片…');
            } else {
                partial = null;
                lastFailed = null;
                renderRetryRow();
                idbClearPartial().catch(() => {});   // 非 async 回调，fire-and-forget
                setStatus('🗑 下载缓存已清空，下次下载将从头开始');
            }
        });

        // 只重试失败切片：本质就是普通下载——partial 缓存里好片会被自动跳过，
        // 所以不需要另一条下载路径，按钮只是把「这次只补 N 片」讲清楚并少点一次。
        const renderRetryRow = () => {
            const row = $('dlr-retry-row');
            if (!row) return;
            const n = lastFailed ? lastFailed.length : 0;
            const show = n > 0 && !DL.running;
            row.style.display = show ? 'flex' : 'none';
            if (!show) return;
            const info = $('dlr-retry-info');
            if (info) {
                const head = lastFailed.slice(0, 12).map((i) => '#' + i).join(' ');
                info.textContent = '上次失败 ' + n + ' 片（' + head +
                    (n > 12 ? ' …' : '') + '），其余切片已缓存';
            }
        };
        window.__renderRetryRow = renderRetryRow;   // 供下载流程在状态变化时刷新
        const retryBtn = $('dlr-retry');
        retryBtn && retryBtn.addEventListener('click', () => {
            if (DL.running || !lastFailed || !lastFailed.length) return;
            setStatus('♻ 正在重试 ' + lastFailed.length + ' 个失败切片…');
            $('dlr-go').click();     // 走同一条下载路径，partial 自动跳过好片
        });
        renderRetryRow();

        // 导出诊断日志：把收集到的现场写成 .txt 存进浏览器下载目录。
        // 用户把它发给我们就能复现问题，比截图和口头描述有效得多。
        const diagBtn = $('dlr-diag');
        diagBtn && diagBtn.addEventListener('click', async () => {
            const oldText = diagBtn.textContent;
            diagBtn.disabled = true;
            diagBtn.textContent = '⏳ 生成中...';
            try {
                const text = buildDiagReport();
                const filename = '钉钉回放下载-诊断-' + stamp() + '.txt';
                // 前置 BOM：Windows 记事本不认无 BOM 的 UTF-8，中文会变乱码
                const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
                await downloadBlob(blob, filename);
                appendLog('📋 诊断日志已导出：' + filename);
                setStatus('📋 已导出诊断日志 ' + filename);
            } catch (e) {
                setStatus('❌ 导出诊断日志失败：' + e.message, true);
            } finally {
                diagBtn.disabled = false;
                diagBtn.textContent = oldText;
            }
        });

        // 导出 m3u8：把当前这一路的切片列表存成标准播放列表。
        // 必须等解析成功才有内容可导，所以没解析时给出明确提示而不是导出空文件。
        const m3u8Btn = $('dlr-m3u8');
        m3u8Btn && m3u8Btn.addEventListener('click', async () => {
            if (!prepCache || !prepCache.parsed || !(prepCache.parsed.segments || []).length) {
                setStatus('⚠ 尚未解析到切片列表，请先点「下载本页回放」或等预取完成', true);
                return;
            }
            const oldText = m3u8Btn.textContent;
            m3u8Btn.disabled = true;
            m3u8Btn.textContent = '⏳ 生成中...';
            try {
                const title = (prepCache.model && prepCache.model.title) || 'replay';
                const text = buildM3u8(prepCache.parsed, title);
                const filename = sanitize(title) + '-' + stamp() + '.m3u8';
                // 不加 BOM：m3u8 要给 ffmpeg / VLC 读，BOM 会让部分解析器把首行当成标签名
                const blob = new Blob([text], { type: 'application/vnd.apple.mpegurl;charset=utf-8' });
                await downloadBlob(blob, filename);
                const n = prepCache.parsed.segments.length;
                appendLog('📄 已导出 m3u8：' + filename + '（' + n + ' 片' +
                    (prepCache.parsed.encrypted ? ' · AES-128' : '') +
                    (prepCache.parsed.fmp4 ? ' · fMP4' : '') + '）');
                setStatus('📄 已导出 ' + filename + '（' + n + ' 片）');
            } catch (e) {
                setStatus('❌ 导出 m3u8 失败：' + e.message, true);
            } finally {
                m3u8Btn.disabled = false;
                m3u8Btn.textContent = oldText;
            }
        });

        // ---------- 队列 UI ----------
        const qBox = $('dlr-queue'), qRow = $('dlr-queue-ctl'),
            qGo = $('dlr-queue-go'), qClear = $('dlr-queue-clear'), qInfo = $('dlr-queue-info');
        const renderQueue = () => {
            const { out, errs } = parseQueueInput(qBox.value);
            if (!qRow) return;
            const n = out.length;
            qRow.style.display = (n || errs.length) ? 'flex' : 'none';
            if (!n && !errs.length) return;
            let msg = n ? (n + ' 个回放待下载') : '';
            if (errs.length) msg += (msg ? '；' : '') + errs.length + ' 行无法识别';
            if (qInfo) qInfo.textContent = msg;
        };
        qBox && qBox.addEventListener('input', renderQueue);
        qBox && qBox.addEventListener('change', renderQueue);
        qClear && qClear.addEventListener('click', () => {
            qBox.value = '';
            Q.items = [];
            renderQueue();
            setStatus('✕ 队列已清空');
        });

        // 调度器：逐个执行。单个失败不中断整队——用户排了 5 个，第 3 个签名过期
        // 不该让 4、5 也不跑完。全部跑完再汇总。
        async function runQueue() {
            if (Q.running) return;
            const { out, errs } = parseQueueInput(qBox.value);
            if (errs.length) {
                appendLog('⚠ 队列有 ' + errs.length + ' 行无法识别：');
                errs.slice(0, 5).forEach((m) => appendLog('   ' + m));
                if (!out.length) { setStatus('❌ 队列里没有可执行的回放', true); return; }
            }
            if (!out.length) { setStatus('⚠ 队列为空', true); return; }

            Q.items = out.map((r, i) => ({ id: ++queueSeq, roomId: r.roomId, liveUuid: r.liveUuid }));
            Q.running = true;
            Q.current = -1;
            qGo.disabled = true;
            qClear.disabled = true;
            const btn = $('dlr-go');
            if (btn) btn.disabled = true;
            const okList = [], failList = [];
            appendLog('▶ 队列开始：共 ' + Q.items.length + ' 个回放，顺序执行');
            try {
                for (let i = 0; i < Q.items.length; i++) {
                    if (DL.cancel) { appendLog('⏹ 队列已被中断，剩余 ' + (Q.items.length - i) + ' 个未执行'); break; }
                    Q.current = i;
                    const it = Q.items[i];
                    setStatus('队列 ' + (i + 1) + '/' + Q.items.length + ' · 正在处理…');
                    appendLog('—— 队列 [' + (i + 1) + '/' + Q.items.length + '] ' +
                        (it.roomId ? 'roomId=' + it.roomId + ' ' : '') + 'liveUuid=' + it.liveUuid);
                    let itemErr = '';
                    try {
                        await run(it.roomId, it.liveUuid, {
                            res: resSel.value,
                            fmt: $('dlr-fmt').value,
                            threads: parseInt($('dlr-thread').value, 10) || 8,
                            retry: parseInt($('dlr-retry').value, 10) || 3,
                            name: '',          // 每个回放各自用标题，不共用一个文件名
                            stamp: $('dlr-stamp').checked,
                            clipFrom: null, clipTo: null,
                        });
                    } catch (e) {
                        // run() 内部已兜住绝大多数错误；这里只兜它之外的意外
                        itemErr = String((e && e.message) || e);
                    }
                    // run() 自己吞掉了异常，不抛——必须读它回写的标志才算数，
                    // 否则四个全失败也会汇总成「成功 4」。
                    if (lastRunResult.ok) {
                        okList.push({ liveUuid: it.liveUuid, name: lastRunResult.name });
                    } else {
                        const reason = itemErr ||
                            ((statusEl && statusEl.textContent) || '未知错误').replace(/^❌\s*失败：/, '');
                        failList.push({ liveUuid: it.liveUuid, err: reason });
                        appendLog('❌ 队列 [' + (i + 1) + '] 失败：' + reason);
                    }
                }
            } finally {
                Q.running = false;
                Q.current = -1;
                if (qGo) qGo.disabled = false;
                if (qClear) qClear.disabled = false;
                if (btn) btn.disabled = false;
                const done = okList.length, bad = failList.length;
                const skipped = Q.items.length - done - bad;
                let summary = '🏁 队列结束：成功 ' + done;
                if (bad) summary += ' · 失败 ' + bad;
                if (skipped > 0) summary += ' · 未执行 ' + skipped;
                appendLog(summary);
                if (okList.length) {
                    appendLog('   ✅ ' + okList.map((o) => o.name || o.liveUuid).slice(0, 8).join('、') +
                        (okList.length > 8 ? ' 等 ' + okList.length + ' 个' : ''));
                }
                failList.slice(0, 5).forEach((f) => appendLog('   ❌ ' + f.liveUuid + ' ' + f.err));
                setStatus(summary + (bad ? '（点状态栏看详情）' : ''), bad > 0);
                try { window.__renderRetryRow && window.__renderRetryRow(); } catch (e) { }
            }
        }
        qGo && qGo.addEventListener('click', runQueue);
        renderQueue();

        $('dlr-go').addEventListener('click', () => {
            // 在用户手势内预热 AudioContext：否则下载完成时页面若已无交互，
            // 浏览器自动播放策略会拦掉提示音（表现为「开了没声音」）
            primeNotifyAudio();
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
                    if (fillResOptions) fillResOptions(prepCache.parsed.variants, prepCache.resInfo);
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