// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      3.0.6
// @description  钉钉直播回放下载器：免登录抓取 m3u8，支持 MP4(默认,已修时长/进度条)/TS、截取时长、内置预览(倍速)、智能调度（贪心优先+并发自适应）、帧级精确截取(实验性)、下载队列、自定义分辨率、完成/失败通知与提示音、失败切片单独重试、导出 m3u8 与诊断日志、毛玻璃面板、收缩为图标、并发与重试、多码率、AES-128、fMP4、进度动画。
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
        const line = t + '' + String(msg);
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
            msg: '未处理的 Promise 拒绝:' + String(r && r.message ? r.message : r).slice(0, 300),
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
        const push = (k, v) => L.push(k.padEnd(14, '') + ':' + v);
        push('脚本版本', VERSION);
        push('生成时间', new Date().toLocaleString('zh-CN'));
        push('页面地址', redactUrl(location.href));
        push('浏览器', navigator.userAgent);
        push('脚本启动', DIAG.startedAt.toLocaleString('zh-CN'));
        push('硬件并发', String(navigator.hardwareConcurrency || '未知') +
            ' (自动识别线程数 ' + Math.max(4, Math.min(16, (navigator.hardwareConcurrency || 4) * 2)) + ')');
        L.push('');

        // —— 下载历史 ——
        L.push('【下载记录】共 ' + DIAG.runs.length + '  次');
        if (!DIAG.runs.length) L.push('   (本次会话没有点过下载)');
        DIAG.runs.forEach((r, i) => {
            L.push('' + (i + 1) + '.' + r.t.replace('T', '').slice(0, 19) +
                '' + (r.ok ? '成功' : '失败') + '' + r.summary);
            if (r.detail) L.push('' + r.detail);
        });
        L.push('');

        // —— 解析结果 ——
        const pc = prepCache && prepCache.parsed;
        L.push('【解析结果】');
        if (!pc) {
            L.push('   (尚未解析成功——这本身就是关键信息: 多为签名过期或接口被拦)');
        } else {
            push('  切片数', String(pc.segments.length));
            push('  总时长', fmtTime(pc.totalDur || 0));
            push('  加密', pc.encrypted ? '是 (AES-128)' : '否');
            push('  fMP4', pc.fmp4 ? '是' : '否');
            if (pc.initSegment) push('  初始化段', redactUrl(pc.initSegment.url));
            if (pc.variants && pc.variants.length) {
                L.push('  多码率档位:');
                pc.variants.forEach((v) => {
                    L.push('' + (v.res || '未标注') + '' + v.bandwidth + ' bps');
                });
            }
        }
        L.push('');

        // —— 缓存与设置 ——
        L.push('【缓存与设置】');
        const cached = partial && partial.datas ? partial.datas.filter(Boolean).length : 0;
        push('  内存缓存', partial ? (cached + ' 片 ' + (partial.key ? '' : ' (key 不匹配)')) : '无');
        push('  后台预下载', pre.datas
            ? (pre.want + '/' + pre.total + ' 片 · ' + fmtBytes(pre.bytes) +
               (pre.running ? ' (进行中)' : (pre.stop ? ' (已中断)' : '')) +
               ' · ' + (preEnabled() ? '开' : '关'))
            : (preEnabled() ? '开 (尚未解析)' : '关'));
        const failed = lastFailed ? lastFailed.length : 0;
        push('  待重试', failed ? (failed + ' 片: #' + lastFailed.slice(0, 20).join(' #')) : '无');
        const readChk = (id, key, def) => {
            try { const v = GM_getValue(key); return v === undefined || v === null ? def : v; }
            catch (e) { return def; }
        };
        push('  并发线程', String(readChk('dlr-thread', 'dlr_thread', '默认')));
        push('  重试次数', String(readChk('dlr-retry-num', 'dlr_retry', '默认')));
        push('  预取', readChk(null, 'dlr_prefetch', true) ? '开' : '关');
        push('  通知', (readChk(null, 'dlr_notify_desktop', false) ? '开' : '关') + ' / 声音 ' +
            (readChk(null, 'dlr_notify_sound', false) ? '开' : '关'));
        L.push('');

        // —— 未捕获异常 ——
        L.push('【未捕获异常】共 ' + DIAG.errors.length + '  条');
        if (!DIAG.errors.length) L.push('   (无)');
        DIAG.errors.forEach((e) => {
            L.push('' + e.t.replace('T', '').slice(0, 19) + '' + e.msg);
            if (e.src) L.push('' + e.src + ':' + e.line);
        });
        L.push('');
        L.push('【面板日志】最近 ' + logHistory.length + '  条');
        logHistory.slice(-80).forEach((l) => L.push('' + l));
        L.push('');
        L.push('—— 报告结束 ——');
        return L.join('\n');
    }

    function setStatus(msg, isErr) {
        const raw = String(msg);
        if (!statusEl) {
            logBuffer.length = 0;
            logBuffer.push(isErr ? raw + ' (面板未挂载)' : raw);
            return;
        }
        pushHistory((isErr ? '❌' : '') + raw);
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
                    else reject(new Error('HTTP' + r.status + '' + (r.response || '').toString().slice(0, 200)));
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
        if (!m.playbackUrl) throw new Error('playbackUrl 为空: code=' + (j.code || '') + ' status=' + (m.status || ''));
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
            throw new Error('mux.js 执行失败 (可能被页面 CSP 拦截):' + e.message);
        }
        muxGlobal = ret || pickMux();
        if (!muxGlobal || !muxGlobal.mp4) throw new Error('mux.js 加载失败 (未取得 mp4.Transmuxer)');
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
            try { appendLog('   ⚠ MP4 duration 修补失败:' + e.message); } catch (e2) { }
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
                else appendLog('   找不到分辨率 ' + wantRes + ', 回落最高带宽 ' + pick.bandwidth + ' bps');
            }
            appendLog('   多码率 ' + variants.length + ' 档, 选择 ' +
                (pick.res || '未标注分辨率') + ' ·' + pick.bandwidth + ' bps');
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

    // ---------- 帧级精确截取（实验性） ----------
    // 切片边界对齐只能精确到 ~30 秒（一个切片的长度）。要做到帧级，必须知道
    // 每个视频帧的 PTS，并从目标时间点之前最近的一个关键帧（IDR）开始切——
    // 从中间帧开始切会导致花屏，因为 P/B 帧依赖前一个 GOP。
    // 实现路线：TS → PES → AnnexB，逐帧解析 slice header 的 first_mb_in_slice==0
    // 且 nal_unit_type 为 5/7（IDR）或 I 帧，得出关键帧时间表。
    // 为什么标「实验性」：依赖视频编码为 H.264 且关键帧信息可从 slice header 读出，
    // 遇到 HEVC/AV1 或 unusual 的流会失败；失败时必须能退回切片对齐。

    // 从一段 TS 数据里提取关键帧的相对时间（毫秒）。
    // 返回按时间升序的 [{ms, byteOffset}]，byteOffset 是该关键帧 IDR 在 annexB 流里的位置。
    function findKeyframes(tsBuf, startMs) {
        // 先做 TS → PES payload 的重组（复用 1.9.0 的思路，但这里要保留时间戳）
        const frames = [];
        let pesBuf = [], pcrMs = 0;
        let baseStart = 0;     // 当前 PES 在整条 TS 流里的起始字节偏移
        let pesTsStart = 0;    // 该 PES 首个 TS 包在整条流里的起点（切片要用）
        let streamLen = 0;    // 已消费的字节数
        let videoPid = -1;    // 视频流 PID（重新封装参数集时要沿用）
        // SPS(7)/PPS(8)：每个流的参数集。切到中途时必须注入到输出开头，
        // 否则播放器找不到解码参数，开头几帧直接花掉。
        const paramSets = { sps: null, pps: null };

        for (let off = 0; off + 188 <= tsBuf.length; off++) {
            if (tsBuf[off] !== 0x47) { off += 186; continue; }
            const pusi = (tsBuf[off + 1] & 0x40) !== 0;
            const pktStart = off;
            const pid = ((tsBuf[off + 1] & 0x1F) << 8) | tsBuf[off + 2];
            const afc = (tsBuf[off + 3] >> 4) & 0x3;
            let p = off + 4;
            // adaptation field 先读 PCR（时间源），payload 起点要跳过它
            if (afc === 2 || afc === 3) {
                const afStart = off + 4;
                const afLen = tsBuf[afStart];
                if (afLen > 0 && afStart + 1 + afLen <= tsBuf.length) {
                    const flags = tsBuf[afStart + 1];
                    if (flags & 0x10) {   // PCR flag
                        const q = afStart + 2;
                        if (q + 5 < tsBuf.length) {
                            const base = (tsBuf[q] << 25) | (tsBuf[q + 1] << 17) |
                                         (tsBuf[q + 2] << 9) | (tsBuf[q + 3] << 1) |
                                         ((tsBuf[q + 4] >> 7) & 1);
                            const ext = ((tsBuf[q + 4] & 1) << 8) | tsBuf[q + 5];
                            pcrMs = base * 300 + ext;    // 27MHz → 毫秒
                        }
                    }
                    // payload 从 adaptation field 之后开始
                    p = afStart + 1 + afLen;
                } else {
                    p = afStart + 1;
                }
            }
            if (afc === 0 || p >= off + 188 || p >= tsBuf.length) { off += 187; continue; }

            if (videoPid < 0 && pusi) videoPid = pid;   // 第一个 PUSI 的 PID 视为视频流
            if (pusi) {
                if (pesBuf.length) {
                    // 上一包 PES 结束，解析它。baseStart 是它在整条流里的起始偏移，
                    // parsePes 把它加到关键帧位置上，得到可切片的全局字节偏移。
                    parsePes(pesBuf, pcrMs, frames, baseStart, paramSets, pesTsStart);
                    pesBuf = [];
                }
                baseStart = streamLen;   // 新 PES 从这里开始
                pesTsStart = pktStart;   // 该 PES 首个 TS 包在整条流里的起点
            }
            for (let i = p; i < off + 188; i++) { pesBuf.push(tsBuf[i]); streamLen++; }
            off += 187;
        }
        if (pesBuf.length) parsePes(pesBuf, pcrMs, frames, baseStart, paramSets, pesTsStart);
        frames.sort((a, b) => a.ms - b.ms);
        frames.paramSets = paramSets;
        // 重新封装参数集时要沿用原视频流的 PID，否则播放器当成另一条流忽略掉
        frames.videoPid = videoPid;
        return frames;
    }

    // 解析一个 PES 包，找出关键帧
    function parsePes(pes, tsMs, frames, baseStart, paramSets, pesTsStart) {
        const b = Uint8Array.from(pes);
        if (b.length < 14) return;
        if (!(b[0] === 0 && b[1] === 0 && b[2] === 1)) return;
        const streamId = b[3];
        // 只看视频流（0xE0~0xEF）
        if (!(streamId >= 0xE0 && streamId <= 0xEF)) return;
        const flags2 = b[7];
        const headerLen = b[8];
        // PES 头布局（b 是从 PES start code 开始的完整字节序列）：
        //   [0..2] start_code  [3] stream_id  [4..5] pkt_len  [6..7] flags
        //   [8] header_len     [9 .. 9+header_len-1] PES header data（含 PTS/DTS）
        //   payload 从 9 + header_len 开始
        const ptsAt = 9;               // header_len >= 5 时，PTS 是 header data 的头 5 字节
        const payloadAt = 9 + headerLen;
        let pts = null;
        if (flags2 & 0x80) {          // PTS 存在
            if (ptsAt + 5 > b.length) return;
            pts = (((b[ptsAt] >> 1) & 0x07) << 30) |
                  (((b[ptsAt + 1] << 7) | (b[ptsAt + 2] >> 1)) << 15) |
                  (((b[ptsAt + 3] << 7) | (b[ptsAt + 4] >> 1)));
        }
        const p = payloadAt;
        const ms = pts !== null ? pts : tsMs;
        // 找 IDR：start code + NAL header 的 type 5 (IDR) 或 7 (SPS 前的 SEI)
        let isIdr = false, hasSps = false;
        for (let i = p; i + 4 < b.length; i++) {
            if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
                const t = b[i + 3] & 0x1F;
                if (t === 5) { isIdr = true; break; }     // IDR = 关键帧
                if (t === 7) hasSps = true;                // SPS 通常紧邻 IDR
            } else if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) {
                const t = b[i + 4] & 0x1F;
                if (t === 5) { isIdr = true; break; }
            }
        }
        // 收集参数集：切到中途时必须带上，否则播放器报「non-existing PPS」开不了头
        for (let i = p; i + 4 < b.length; i++) {
            let nt = -1, np = i;
            if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) { nt = b[i + 3] & 0x1F; np = i + 3; }
            else if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) { nt = b[i + 4] & 0x1F; np = i + 4; }
            else continue;
            if (nt === 7) {          // SPS
                let e = b.length;
                for (let j = np + 1; j + 3 < b.length; j++) {
                    if (b[j] === 0 && b[j + 1] === 0 && b[j + 2] <= 1) { e = j; break; }
                }
                if (!paramSets.sps) paramSets.sps = b.slice(i, e);
                if (i > p + 64) break;
            } else if (nt === 8) {   // PPS
                let e = b.length;
                for (let j = np + 1; j + 3 < b.length; j++) {
                    if (b[j] === 0 && b[j + 1] === 0 && b[j + 2] <= 1) { e = j; break; }
                }
                if (!paramSets.pps) paramSets.pps = b.slice(i, e);
                if (i > p + 64) break;
            }
        }
        if (isIdr || (hasSps && b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1 &&
                      (b[p + 3] & 0x1F) === 5)) {
            // byteOffset 必须是相对整条流的绝对位置，否则切片时坐标系对不上
            frames.push({
                ms: ms,
                byteOffset: (baseStart || 0) + p,
                tsStart: pesTsStart || 0,     // 该 PES 首个 TS 包在流里的起点
                size: b.length - p,
                isIdr: isIdr,
            });
        }
    }

    // 把 SPS+PTS 封成合法的 TS 包序列。
    // 为什么必须重新打包、不能直接把裸 NAL 粘到流前面：
    // 解复用器按 188 字节对齐扫包，开头多出的裸字节会让它把后面所有包的
    // PID/continuity 判断全搞乱，症状是「non-existing PPS」+ 开头一堆帧解码失败。
    // 正确做法是构造一个全新的、语法合法的 PES + TS 包插到输出最前面。
    function buildParamSetTs(sps, pps, pid, pcrMs) {
        const payload = new Uint8Array(sps.length + pps.length);
        payload.set(sps, 0);
        payload.set(pps, sps.length);
        // PES 头共 9 字节（start_code 3 + stream_id 1 + pkt_len 2 + flags 2 + header_len 1），
        // 之后是 5 字节 PTS，payload 从第 14 字节（下标 14）开始。
        const pes = new Uint8Array(14 + payload.length);
        pes[0] = 0; pes[1] = 0; pes[2] = 1; pes[3] = 0xE0;   // 视频流
        pes[4] = 0; pes[5] = 0;                             // pkt_length = 0
        pes[6] = 0x80; pes[7] = 0x00;                        // PTS 存在，无 DTS
        pes[8] = 0x05;                                      // header_len = 5（只有 PTS）
        // PTS（33bit，marker bit 置 1）
        const p = (pcrMs || 0) * 90;
        pes[9]  = 0x21 | (((p >> 29) & 0x0E) | 0x00);
        pes[10] = ((p >> 22) & 0xFF);
        pes[11] = (((p >> 14) & 0xFE) | 0x01);
        pes[12] = ((p >> 7) & 0xFE);
        pes[13] = ((p << 1) & 0xFE) | 0x01;
        pes.set(payload, 14);

        // 按 184 字节有效载荷切成 TS 包
        const out = [];
        const total = pes.length;
        const packets = Math.ceil(total / 184);
        for (let i = 0; i < packets; i++) {
            const pkt = new Uint8Array(188);
            pkt[0] = 0x47;
            pkt[1] = (i === 0 ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);   // 首包带 PUSI
            pkt[2] = pid & 0xFF;
            pkt[3] = 0x10 | (i & 0x0F);      // 仅有效载荷，continuity 递增
            const from = i * 184;
            const n = Math.min(184, total - from);
            pkt.set(pes.slice(from, from + n), 4);
            out.push(pkt);
        }
        return out;
    }


    // 帧级截取的执行体。datas 是已下载的切片数组，segs 是对应元信息。
    // 返回裁剪后的字节数组；找不到可靠切点时抛错，由调用方退回切片对齐。
    function clipFrames(datas, segs, segStarts, fromMs, toMs) {
        // 把所有切片拼成一条 TS 流，边拼边扫关键帧，记录每片在全局的字节偏移
        const chunks = [];
        let total = 0;
        for (const d of datas) { if (d && d.length) { chunks.push(d); total += d.length; } }
        if (!total) throw new Error('没有可用的切片数据');
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }

        const kfs = findKeyframes(all, 0);
        if (kfs.length < 2) throw new Error('未能在视频流中找到足够的帧级切点 (' + kfs.length + ' 个关键帧)');

        // 时间轴对齐是这里最容易出错的地方。
        // 传入的 datas 往往只是「截取区间内的切片」，不是完整回放——它的第一个
        // 关键帧并不对应回放 0 秒。必须用切片自身的起始时间做基准：
        //   datas 里第 0 片的回放起始 = segStarts[0]（秒）
        //   该片第一个关键帧的 PTS = kfs[0].ms
        //   → 关键帧 k 的回放时间 = segStarts[0] + (k.ms - kfs[0].ms)/90000
        const baseMs = kfs[0].ms;
        const segStart0 = (segStarts && segStarts.length && typeof segStarts[0] === 'number')
            ? segStarts[0] : 0;
        const kfSec = kfs.map((k) => segStart0 + (k.ms - baseMs) / 90000);

        // 起点：最后一个 <= fromMs 的关键帧；没有就用第一个
        let startIdx = 0;
        for (let i = 0; i < kfSec.length; i++) {
            if (kfSec[i] <= fromMs / 1000) startIdx = i; else break;
        }
        // 终点：第一个 >= toMs 的关键帧；没有就用最后一个
        let endIdx = kfSec.length - 1;
        for (let i = kfSec.length - 1; i >= 0; i--) {
            if (kfSec[i] >= toMs / 1000) endIdx = i; else break;
        }
        if (endIdx < startIdx) endIdx = startIdx;

        // 关键：切片必须落在 TS 包边界（0x47）上。
        // 直接按 PES 内偏移切会切出「裸流」——没有 188 字节包封装，
        // ffprobe 能靠扫描猜出时长，但解码器找不到包边界，开头一堆帧全废。
        const alignToTs = (from) => {
            let i = from;
            // 往前找最近的 0x47（最多 3 个包，因为关键帧前通常只有 SEI/AUD 包）
            for (let k = 0; k < 4; k++) {
                if (i <= 0) return 0;
                if (all[i] === 0x47) return i;
                i--;
            }
            return from;
        };
        // 用 tsStart（该关键帧所在 TS 包的起点），不是 PES 内偏移——
        // 否则切出来的开头不是包边界，解复用器一上来就对不齐。
        let startByte = alignToTs(kfs[startIdx].tsStart || kfs[startIdx].byteOffset);
        let endByte = (endIdx + 1 < kfs.length)
            ? (kfs[endIdx + 1].tsStart || kfs[endIdx + 1].byteOffset)
            : all.length;
        endByte = alignToTs(endByte);
        if (endByte < startByte) endByte = all.length;
        let body = all.slice(startByte, endByte);
        // 长度必须是 188 的整数倍，否则末包不完整
        const bodyLen = body.length - (body.length % 188);
        if (bodyLen > 0 && bodyLen !== body.length) body = body.slice(0, bodyLen);

        // 参数集：从中途切出来的流，开头第一个 IDR 之前没有 SPS/PPS，
        // 播放器会报 "non-existing PPS" 然后跳过开头若干帧。
        // 这里把 SPS/PPS 重新封装成合法 TS 包插到最前面（不能裸粘字节，会破坏对齐）。
        const ps = kfs.paramSets || {};
        let injected = false;
        if (ps.sps && ps.pps) {
            const vidPid = kfs.videoPid != null ? kfs.videoPid : 256;
            const pkts = buildParamSetTs(ps.sps, ps.pps, vidPid, kfs[startIdx].ms);
            const headLen = pkts.length * 188;
            const head = new Uint8Array(headLen);
            pkts.forEach((pk, i) => head.set(pk, i * 188));
            const merged = new Uint8Array(headLen + body.length);
            merged.set(head, 0);
            merged.set(body, headLen);
            body = merged;
            injected = true;
        }
        return {
            bytes: body,
            actualFromSec: kfSec[startIdx],
            actualToSec: kfSec[Math.min(endIdx + 1, kfSec.length - 1)],
            keyframes: kfSec.length,
            startKeyframeSec: kfSec[startIdx],
            injectedParams: injected,
        };
    }

    // ---------- 面板拖拽定位（v2.4.0，纯函数便于单测） ----------
    // 面板原本靠 CSS 的 right/bottom 固定在右下角。拖过之后改用 left/top 精确定位，
    // 所以必须把「视口左上角坐标」换算回 right/bottom，否则窗口尺寸一变就错位。
    //
    // 钳制策略是刻意不对称的：**只夹 x，不夹 y**。
    // 面板展开后可以比视口还高（内容多时 700px+ 很正常），若把 y 也夹进视口，
    // 面板高度超过视口时就永远只能贴在顶部、拖不下去——用户会觉得「拖不动」。
    // 纵向可以超出视口（页面本身能滚，面板跟着滚就行），横向必须夹住，
    // 否则面板会整个消失到屏幕外、用户找不到也拖不回来。
    function clampPanelPos(x, y, w, h, vw, vh) {
        const gap = 8;
        const maxX = Math.max(gap, vw - w - gap);
        return {
            x: Math.min(Math.max(x, gap), maxX),
            y: Math.max(gap, y),          // 只保留下边界，顶部不被裁掉
        };
    }
    // 把 left/top 坐标反算成 CSS 的 right/bottom（面板宽度未知时用当前实测值）
    function posToRightBottom(x, y, w, h, vw, vh) {
        const c = clampPanelPos(x, y, w, h, vw, vh);
        return {
            left: c.x + 'px',
            top: c.y + 'px',
            // right/bottom 允许为 0：面板超出视口时本就没有"到右边的距离"
            right: Math.max(0, vw - c.x - w) + 'px',
            bottom: Math.max(0, vh - c.y - h) + 'px',
        };
    }

    // ---------- 截取时间输入的单位上限（v2.3.0） ----------
    // 用户不该先猜「这场回放有多长」再决定填 mm:ss 还是 hh:mm:ss。
    // 这里按已解析出的回放总时长推出「上限形态」：
    //   总时长 ≥ 1 小时  → hh:mm:ss（三段，小时位不限 99，可到 100:00:00）
    //   总时长 <  1 小时 → mm:ss（两段，分钟位可超 59，如 90:00）
    //   回放还没解析出来 → 不预设上限，只把已填内容规范化（补零、去掉多余冒号）。
    // 纯函数，不碰 DOM，便于单测；返回 {unit, text}。
    function clipTimeHint(totalDurSec) {
        const dur = Number(totalDurSec);
        const has = isFinite(dur) && dur > 0;
        const unit = has && dur >= 3600 ? 'hh:mm:ss' : 'mm:ss';
        // capHint 必须按**用户将要填的同一个 unit** 渲染，否则提示里的数字
        // 照抄进输入框会得到另一个时刻。fmtTime() 对 >=1h 固定输出 h:mm:ss，
        // 而 mm:ss 形态下总时长该写成 "01:30" / "90:00" 这种（分钟可以超过 59）。
        // 注意 mm:ss 必须保留秒：90 秒要写 "01:30"，不能四舍五入成 "2:00"。
        const capHint = has
            ? (unit === 'mm:ss'
                ? (function () {
                    const m = Math.floor(dur / 60), s = Math.round(dur % 60);
                    return String(m).padStart(2, '0') + ':' +
                        String(s).padStart(2, '0');
                })()
                : fmtTime(dur))
            : null;
        return { unit: unit, capHint: capHint };
    }

    // 把用户输入规范化成「上限形态」的文本：补零到两位、去掉多余的冒号层数。
    // 只做无损变换，不改变时刻本身；非法输入原样返回，交给 parseTimeArg 报错。
    // 零宽字符用码点数值过滤而不是往正则里塞不可见字面量——编辑工具会在改写时
    // 悄悄吃掉其中一个（U+200B 就这么丢过一次），写死码点不会被文本层改写影响。
    // 码点表内联在函数里：单测抽取器只抽函数体、不抽外层 const，
    // 放外面会变成 ReferenceError。
    function stripClipNoise(s) {
        return String(s).split('').filter((ch) => {
            const c = ch.codePointAt(0);
            if (c === 0x20 || (c >= 0x09 && c <= 0x0D)) return false;  // 空格/tab/换行
            if (c === 0xA0 || c === 0x3000) return false;             // 不换行空格/全角空格
            if (c === 0x200B || c === 0x200C || c === 0x200D || c === 0xFEFF) return false;  // 零宽/BOM
            return true;
        }).join('');
    }
    function normalizeClipText(raw, unit) {
        const s = stripClipNoise(
            String(raw == null ? '' : raw)
                .replace(/[：︰﹕]/g, ':')
                .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        );
        if (!s) return '';
        const p = s.split(':');
        if (p.some((x) => !/^\d+$/.test(x))) return s;   // 非法字符，不动
        const n = p.map((x) => parseInt(x, 10));
        const pad = (x) => String(x).padStart(2, '0');
        if (unit === 'hh:mm:ss') {
            // 只在「已经是三段」时规范化。两段（1:30）含义歧义——既可能读成
            // 1分30秒，也可能读成 1小时30分——所以原样交给 parseTimeArg 按
            // 既定规则（两段=mm:ss）解析，绝不在这里替用户猜。
            if (n.length !== 3) return s;
            return pad(n[0]) + ':' + pad(n[1]) + ':' + pad(n[2]);
        }
        // mm:ss：两段时首位是分钟不补零（90:00 保持原样），秒位补零。
        // 裸数字补零成两位；其余层数（3 段、4 段…）原样返回——
        // 早先写成无条件 pad(n[0]) 会把 '1:2:3' 静默截断成 '01'，
        // 用户输入被篡改且毫无提示，这个 bug 是浏览器验收抓出来的，单测没覆盖到。
        if (n.length === 2) return n[0] + ':' + pad(n[1]);
        if (n.length === 1) return pad(n[0]);
        return s;
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
            throw new Error(who + '含非法字符, 只接受数字与冒号 (例: 12:34 或 1:02:03), 收到:' + v);
        }
        const p = s.split(':');
        if (p.length > 3) throw new Error(who + '最多 hh:mm:ss 两层冒号:' + v);
        if (p.some((x) => x === '')) throw new Error(who + '冒号不能连写或出现在两端:' + v);
        const n = p.map((x) => parseInt(x, 10));
        if (n.some((x) => !isFinite(x) || x < 0)) throw new Error(who + '必须为非负整数:' + v);
        // 秒位必须 ≤59；三位时分钟位也必须 ≤59（两位时首位是分钟，可超过 59，如 90:00）
        const ss = n[n.length - 1];
        if (ss > 59) throw new Error(who + '的秒位不能超过 59 (得到 ' + ss + '), 可用 ' + fmtTime(n.length === 1 ? n[0] : (n.length === 2 ? n[0] * 60 + ss : n[0] * 3600 + n[1] * 60 + ss)) + ' 表示:' + v);
        if (n.length === 3 && n[1] > 59) throw new Error(who + '的分钟位不能超过 59:' + v);
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
            throw new Error('结束时间需晚于开始时间 (开始 ' + fmtTime(from) +
                ' ≥ 结束 ' + fmtTime(to) + ')');
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
        if (!kept.length) throw new Error('所选时间段内没有切片 (回放总时长 ' + fmtTime(fullDur) + ')');
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
        if (!t) throw new Error('分辨率为空, 格式如 1280x720');
        const m = /^(\d{2,5})x(\d{2,5})$/.exec(t);
        if (!m) throw new Error('格式不对, 应为 宽x高 (如 1280x720), 收到:' + v);
        const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
        if (w < 16 || h < 16) throw new Error('宽高至少 16 像素, 收到:' + w + 'x' + h);
        // 上限对齐脚本里 parseSpsToDims 的校验，避免下拉里塞进必然失败的选项
        if (w > 7680 || h > 4320) throw new Error('超出 7680x4320 上限, 收到:' + w + 'x' + h);
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
            throw new Error('不支持的 HLS 加密方式:' + seg.key.method);
        }
        return { bytes, end: consumedEnd };
    }

    // ---------- UI ----------
    // 样式注入双保险：优先 GM_addStyle，失败则退回原生 <style>。
    // Tampermonkey 沙箱里 GM_addStyle 偶发失效（样式整段丢失且不报错），
    // 那样折叠区既无高度又 opacity:0 —— 表现为「打开更多设置什么都没有」。
    (function injectStyle(cssText) {
        let done = false;
        try { if (typeof GM_addStyle === 'function') { GM_addStyle(cssText); done = true; } }
        catch (e) { done = false; }
        try {
            if (!done) {
                const s = document.createElement('style');
                s.textContent = cssText;
                (document.head || document.documentElement).appendChild(s);
            }
        } catch (e) {
            const s = document.createElement('style');
            s.textContent = cssText;
            (document.head || document.documentElement).appendChild(s);
        }
    })(`
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
        /* 下载光环：面板最外层一圈流动的渐变光带。
           关键设计（v3.0.5 重写）：**光环不再是独立 fixed 层，而是 .body 的兄弟节点，
           尺寸完全由 CSS 决定**——绝对定位 + inset:0 + width/height:100%，浏览器自己
           把它撑到与面板同大同小。之前那套「JS 读 getBoundingClientRect 再回写 width/
           height/left/top」在原理上就一定会漏：面板尺寸变化的**原因**有十几次（transition、
           子元素展开、内容换行、窗口缩放、字体加载），JS 只能靠事件去追，追漏一次就永久
           错位（实测 20~187px）。改成 CSS 约束后不存在「追不上」这件事。
           SVG 用 pathLength=100 归一化周长，于是 dasharray 是纯比例（28 72），
           面板怎么变宽变窄，光带长度都占 28%，不需要按真实周长重算。
           rx 用百分比：描边落在面板圆角之外 1.5px 处，圆角随尺寸自适应。 */
        #dlr-ring{position:absolute;left:0;top:0;width:100%;height:100%;
            pointer-events:none;z-index:2;overflow:visible;
            opacity:0;transition:opacity 400ms ease-out}
        #dlr-ring.on{opacity:1}
        #dlr-ring .ring-track{fill:none;stroke:rgba(61,110,255,.28);stroke-width:3;
            vector-effect:non-scaling-stroke}
        #dlr-ring .ring-beam{fill:none;stroke-width:3.5;stroke-linecap:round;
            filter:drop-shadow(0 0 5px rgba(61,110,255,.85));
            animation:dlrRingDash 3s linear infinite}
        /* pathLength=100 把真实周长（几百~几千 px）归一化成 100，
           所以 dasharray 与 dashoffset 都可以写成固定的「比例」值。
           动画一整周期正好走完归一化后的一圈，与面板实际大小无关。 */
        @keyframes dlrRingDash{
            from{stroke-dashoffset:0}
            to{stroke-dashoffset:-100}
        }
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
        /* 拖拽把手（v2.4.0）：标题区整块可拖，光标变 move 表示可拖。
           user-select:none 是关键——否则拖动会顺带选中标题文字，手感很脏。
           touch-action:none 让触屏/触控笔也能拖，而不是触发页面滚动。 */
        #dlr-panel .drag{cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
        #dlr-panel .drag:active{cursor:grabbing}
        /* 拖动中：禁掉过渡，否则 width/left 一起动画会粘滞 lagging 手感 */
        #dlr-panel.dragging{transition:none!important}
        #dlr-panel.dragging .drag{cursor:grabbing}
        /* 「点这里打开帧级截取」的跳转高亮：只在用户点过来时闪一下，
           不用持续动画——面板常驻视线内，闪一下足够指路，不必一直晃。 */
        #dlr-panel .chk.flash{animation:dlrFlash 1.1s ease-out 2}
        @keyframes dlrFlash{0%,100%{background:transparent}
            40%{background:rgba(61,110,255,.32);border-radius:5px}}
        #dlr-panel.frost .body{backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%)}
        #dlr-panel .drag{padding-right:48px}   /* 让开右上角「收起」按钮 */
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
        #dlr-status:not(.hist)::before{content:'🕘';opacity:.55}
        #dlr-panel .err{color:#ff7a7a}
        /* 输出框（预览播放器）的展开/收起动画（v2.6.0）。
           display:none ↔ block 是瞬间切换、无法过渡，所以改用
           grid-template-rows:0fr→1fr + opacity，与面板其他折叠区同一条曲线，
           内容与外壳同步收放，不会出现「外壳缩完了内容还在」的错位。 */
        #dlr-preview{height:0;overflow:hidden;opacity:0;
            margin-top:0;border-top:1px solid transparent;padding-top:0;
            transition:height 280ms cubic-bezier(0.16,1,0.3,1),
                opacity 200ms ease-out,margin-top 280ms cubic-bezier(0.16,1,0.3,1),
                padding-top 280ms cubic-bezier(0.16,1,0.3,1),
                border-color 280ms ease-out}
        #dlr-preview.show{opacity:1;margin-top:10px;border-top-color:#23262e;padding-top:10px}
        /* 展开高度由 JS 按内容实测写内联 height（见 showPreview）。
           不靠 CSS 的 max-height：钉钉页面样式表顺序会让展开值被收起值压住。 */
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
        #dlr-panel .more-body{display:block;height:0;opacity:0;overflow:hidden;
            transition:height 260ms cubic-bezier(0.16,1,0.3,1),
                opacity 200ms cubic-bezier(0.4,0,0.2,1)}
        #dlr-panel .more-body>div{min-height:0}
        /* 展开态只改透明度，高度一律交给 JS 内联写。
           绝不能在这里写 height:auto —— 收起态靠 height:0 折叠，
           展开态若改成 auto，两者语义冲突，下方元素会被顶到错误位置。 */
        #dlr-panel .more-body.open{opacity:1}
        #dlr-panel .more-body .row:first-child{margin-top:6px}
        /* ---------- 视口自适应（v2.6.1） ----------
           全部展开时面板可能比窗口还高（笔记本视口常只有 700~900px）。
           用 max-height 限制 .body 高度并让它内部滚动，面板永远不会超出视口；
           收起态不受影响（高度由内容决定，max-height 只是上限）。 */
        #dlr-panel .body{max-height:calc(100vh - 140px);overflow-y:auto;overflow-x:hidden;
            scrollbar-width:thin}
        #dlr-panel .body::-webkit-scrollbar{width:6px}
        #dlr-panel .body::-webkit-scrollbar-thumb{background:#3a3f4b;border-radius:3px}
        #dlr-panel .body::-webkit-scrollbar-track{background:transparent}
        /* 紧凑排版（v2.6.1）：全部展开也不能超出视口 ----------
           原来每个区块都叠 margin-top:8 + padding-top:8 + row margin:6，输入框 34px 高，
           全部展开后面板高达 1178px —— 而常见笔记本视口只有 700~900px，必然溢出。
           这里统一收紧间距与控件高度，不改结构、不动逻辑。
           实测：1178px → 约 760px（约 -35%）。 */
        #dlr-panel .sec{padding-top:5px;margin-top:5px}
        #dlr-panel .row{margin:3px 0;gap:5px}
        #dlr-panel .tip{margin-top:2px;font-size:10.5px;line-height:1.35}
        #dlr-panel input[type=text],#dlr-panel input[type=number],#dlr-panel select{
            padding:3px 6px;font-size:12px}
        #dlr-panel textarea{padding:4px 6px;font-size:12px}
        #dlr-panel button{padding:3px 8px}
        #dlr-panel h3{font-size:13px;margin-bottom:1px}
        #dlr-panel .sub{font-size:11px}
        /* 更多设置内部再紧一档 */
        #dlr-panel .more-body .mrow{margin-top:4px}
        #dlr-panel .more-body .grid2{margin-top:4px;gap:1px 8px}
        /* 紧凑排版（v2.6.0）：数字/下拉两两并排，开关类选项排成两列网格。
           用户要求「两个选项放同一行的左右两边」——原来每项独占一行，
           十来个开关要滚很久。 */
        #dlr-panel .mrow{display:flex;gap:8px;margin-top:6px}
        #dlr-panel .mrow>.row{flex:1;min-width:0;margin-top:0}
        #dlr-panel .mrow>.row>label{flex:0 0 auto;white-space:nowrap}
        #dlr-panel .mrow>.row>input[type=number]{flex:1;min-width:0;width:auto}
        #dlr-panel .mrow>.row>select{flex:1;min-width:0;width:auto}
        #dlr-panel .grid2{display:grid;grid-template-columns:1fr 1fr;
            gap:2px 10px;margin-top:6px}
        #dlr-panel .grid2>.chk{min-width:0;font-size:12px;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #dlr-panel .grid2>.chk>input{flex:0 0 auto}
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
        /* 收起横条。display:none ↔ flex 是瞬间切换、无法过渡，和 body 的
           280ms 高度收缩不同步——收起时会看到横条「啪」地闪出来。
           改成 grid-template-rows:0fr→1fr + opacity，与 body 用同一条曲线，
           两边同时开始、同时结束（v2.6.0 修复收起动画错位）。 */
        #dlr-panel .expand{height:0;overflow:hidden;opacity:0;
            cursor:pointer;padding:0 12px;color:#d7d9de;font-size:12px;
            background:rgba(22,24,29,.92);border-radius:12px;
            transition:height 280ms cubic-bezier(0.16,1,0.3,1),
                opacity 200ms ease-out,padding 280ms cubic-bezier(0.16,1,0.3,1)}
        #dlr-panel .expand .ex-inner{display:flex;flex-direction:column;gap:7px;padding:9px 12px}
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
        #dlr-panel.mini .expand{opacity:1}   /* 高度由 applyMini 用内联写入 */
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
        <div class="expand drag" id="dlr-exp" title="点击展开面板, 按住拖动可移动">
            <div class="ex-inner">
                <div class="ex-row"><span class="ic">⬇</span><span class="lb" id="dlr-ex-title">钉钉直播回放下载</span></div>
                <div class="ex-track"><div class="ex-bar" id="dlr-ex-bar"></div></div>
            </div>
        </div>
        <div class="body">
        <button class="collapse" title="收缩为图标">收起</button>
        <div class="bin">
        <div class="drag">
        <h3>钉钉直播回放下载</h3>
        <div class="sub">免登录, 公开接口抓取 m3u8</div>
        </div>
        <div class="sec"><div class="row"><input type="text" id="dlr-url" placeholder="粘贴回放链接, 或自动读取本页"></div>
            <div class="row" style="margin-top:6px">
                <textarea id="dlr-queue" rows="2" style="flex:1;resize:vertical;font:inherit;font-size:12px;
                    background:#1b1e26;color:#e6e8eb;border:1px solid #2f3440;border-radius:6px;padding:6px 8px"
                    placeholder="队列(可选): 每行一个回放, 整段链接或 roomId liveUuid; 按顺序依次下载"></textarea>
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
                <input type="text" id="dlr-name" placeholder="回放标题解析中..." style="flex:1">
            </div>
            <div class="row">
                <label class="chk"><input type="checkbox" id="dlr-stamp">文件名加时间戳</label>
            </div>
            <div class="row">
                <label>格式</label>
                <select id="dlr-fmt" style="flex:1">
                    <option value="mp4" selected>.mp4 (mux.js 转封装, 默认)</option>
                    <option value="ts">.ts (原始拼接, 最稳)</option>
                </select>
            </div>
            <div class="row">
                <label>分辨率</label>
                <select id="dlr-res" style="flex:1"><option value="">自动 (原始分辨率)</option></select>
            </div>
            <div class="row">
                <label>截取</label>
                <input type="text" id="dlr-from" placeholder="开始" style="width:112px" spellcheck="false">
                <label style="min-width:16px">至</label>
                <input type="text" id="dlr-to" placeholder="结束" style="width:112px" spellcheck="false">
            </div>
            <div class="tip" id="dlr-clip-tip"></div>
        </div>
        <div class="sec"><div class="row"><button id="dlr-go" class="primary"><span id="dlr-spin"></span>下载本页回放</button></div></div>
        <div id="dlr-progress"><div class="bar"></div><div class="stripes"></div><div class="pct">0%</div></div>
        <div id="dlr-status">就绪.</div>
        <div id="dlr-ctl" class="row" style="display:none">
            <button id="dlr-pause" title="暂停/继续下载">⏸ 暂停</button>
            <button id="dlr-cancel" title="中断本次下载 (已下载的可保留)">⏹ 中断</button>
            <button id="dlr-purge" title="删除全部已下载的切片缓存">🗑 删除已下载</button>
        </div>
        <div id="dlr-retry-row" class="row" style="display:none">
            <button id="dlr-retry" title="只重新下载上次失败的切片, 其余用缓存">♻ 只重试失败切片</button>
            <span id="dlr-retry-info" class="tip" style="flex:1"></span>
        </div>
        <div class="row">
            <button id="dlr-diag" title="把版本, 解析结果, 失败片号, 未捕获异常等导出为 .txt, 便于排查问题">📋 导出诊断日志</button>
            <button id="dlr-m3u8" title="把当前选中分辨率的切片列表导出为 .m3u8, 可用 VLC / ffmpeg 重新拉取">📄 导出 m3u8</button>
        </div>
        <div id="dlr-preview"></div>
        <div class="sec">
            <div class="more-toggle" id="dlr-more-t" role="button" aria-expanded="false">更多设置<span class="mt-ic"></span></div>
            <div class="more-body" id="dlr-more-b"><div>
                <div class="mrow">
                    <div class="row"><label>并发线程</label>
                        <input type="number" id="dlr-thread" min="1" max="16" value="5"></div>
                    <div class="row"><label>重试</label>
                        <input type="number" id="dlr-retry-num" min="1" max="10" value="3"></div>
                </div>
                <div class="mrow">
                    <div class="row"><label>面板状态</label>
                        <select id="dlr-mini-def">
                            <option value="0" selected>默认展开</option>
                            <option value="1">默认收缩</option>
                        </select></div>
                    <div class="row"><label>更新源</label>
                        <select id="dlr-updsrc">
                            <option value="gitee">Gitee (默认)</option>
                            <option value="github">GitHub</option>
                            <option value="auto">自动</option>
                        </select></div>
                </div>
                <div class="grid2">
                    <label class="chk"><input type="checkbox" id="dlr-smart">智能调度</label>
                    <label class="chk" title="默认关闭. 开启后起止点会对齐到关键帧, 但需要先下载完整回放再裁剪, 流量更多.">
                        <input type="checkbox" id="dlr-frameclip">帧级精确截取</label>
                    <label class="chk"><input type="checkbox" id="dlr-prefetch">预取播放信息</label>
                    <label class="chk"><input type="checkbox" id="dlr-frost">开启毛玻璃效果</label>
                    <label class="chk"><input type="checkbox" id="dlr-autoupdate">自动检查更新</label>
                    <label class="chk" title="拖动面板时自动收起 更多设置 与输出区. 默认开启.">
                        <input type="checkbox" id="dlr-drag-collapse">拖动时自动收起设置</label>
                    <label class="chk" title="打开页面后, 解析出切片列表时就在后台静默下载切片, 点下载时只需合并保存. 仅存内存, 刷新即丢弃.">
                        <input type="checkbox" id="dlr-predownload">解析后后台预下载</label>
                    <label class="chk" title="下载结束(成功保存或失败报错)时弹出系统通知, 点击可回到面板. 默认关闭.">
                        <input type="checkbox" id="dlr-notify-desktop">完成/失败通知</label>
                    <label class="chk"><input type="checkbox" id="dlr-notify-sound">完成/失败提示音</label>
                </div>
                <div class="tip">预取播放地址与切片索引, 打开页面后无需等待即可直接下载.</div>
            </div></div>
        </div>
        <div class="foot">
            <span>v<span id="dlr-ver">--</span></span>
            <span id="dlr-update" title="检查更新; 发现新版后点击跳转下载页">检查更新</span>
            <span style="color:#3a3f4b">|</span>
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
        cap.textContent = '预览:' + name;
        ctl.appendChild(cap);
        ctl.appendChild(sp);
        box.appendChild(ctl);

        close.addEventListener('click', () => {
            try { URL.revokeObjectURL(v.src); } catch (e) {}
            box.innerHTML = '';
            box.classList.remove('show');   // 收起（带动画）
            box.style.opacity = '0';
            box.style.height = '0px';
        });
        // 展开（带动画）。用 class + 内联 height，不用 display（display 无法过渡）。
        void box.offsetWidth;               // 强制回流，确保连续两次调用也能重放动画
        box.classList.add('show');
        // 实测内容高度写内联：内联优先级高于样式表，不受 CSS 特异性竞争影响。
        // 量高前先解除 height 约束：收起态下 scrollHeight 恒为 0。
        // 同 setMore：opacity 与高度都用内联（class 规则在本页不可靠）。
        box.style.opacity = '1';
        box.style.height = '300px';
        setTimeout(() => {
            const prevH = box.style.height;
            box.style.height = 'auto';
            const h = box.scrollHeight;
            box.style.height = prevH;
            if (h > 0) box.style.height = h + 'px';
        }, 0);
    }

    // ---------- 下载控制：暂停 / 继续 / 中断 / 删除已下载 ----------
    // DL 跨 run 存活；partial 保存已下载切片实现「中断再下 = 断点续传」。
    // partial.failed 记录上次失败的片号与原因，用于「只重试失败切片」的提示文案
    // 与「换更低并发重试」建议——好片永远留在 datas 里，不会被重复下载。
    const DL = { pause: false, cancel: false, running: false, purge: false };
    let partial = null;   // {key, datas} —— 中断时保留，purge 时清空

    // ---------- 解析阶段后台预下载（v2.7.0） ----------
    // 打开页面 → prefetch 解析出切片列表时就开始静默拉片，用户点「下载」时
    // 只需合并保存，把「等切片」这一段等待前置到浏览页面的时间里。
    //
    // 为什么单独存一份而不复用 partial：
    //   partial 的 key 含截取区间(roomId|liveUuid|res|from-to)，而预下载发生在
    //   用户还没设截取时，两者 key 必然不同，复用等于永远命不中。而且 IndexedDB
    //   只有单槽，若预下载去写它，会和用户正式下载的断点缓存抢槽——用户中途
    //   「删除已下载」时就得连带清掉预下载。所以预下载只放内存、不落盘：
    //   刷新页面即丢弃，语义清晰，也不会产生「删不掉」的幽灵缓存。
    const pre = {
        key: null,        // roomId|liveUuid|res
        datas: null,      // 与 parsed.segments 一一对应，未完成处为 null
        want: 0,          // 已完成片数
        bytes: 0,         // 已缓存字节
        total: 0,         // 总片数
        stop: false,      // 用户点中断 / 开始正式下载时置 true
        running: false,
    };
    const preEnabled = () => {
        try {
            const v = GM_getValue('dlr_predownload');
            return v === undefined || v === null ? true : !!v;   // 默认开
        } catch (e) { return true; }
    };
    const preReset = (key, n) => {
        pre.key = key; pre.datas = new Array(n).fill(null);
        pre.want = 0; pre.bytes = 0; pre.total = n; pre.stop = false; pre.running = false;
    };
    // 取用：命中同一 key 才复用；正式下载开始后停掉预下载，避免两边同时拉同一片
    const preTake = (key) => {
        if (!pre.datas || pre.key !== key) return null;
        let n = 0, bytes = 0;
        const out = new Array(pre.total);
        for (let i = 0; i < pre.total; i++) {
            if (pre.datas[i]) { out[i] = pre.datas[i]; n++; bytes += pre.datas[i].length; }
        }
        return { datas: out, count: n, bytes };
    };
    // 上次失败的片号（1-based）。为 null 表示没有待重试的失败片，按钮隐藏。
    // 成功/换 key/删除缓存时清空——避免拿上一轮的数字误导用户。
    let lastFailed = null;

    // 截取输入的单位上限跟随回放总时长（v2.3.0）。prep() 与 init() 是兄弟函数，
    // 作用域不通，所以用模块级钩子把「总时长已知」这件事传出去。
    let onClipDur = null;

    // 拖拽状态。放模块级是因为 setMini/横条 click 的绑定早于拖拽代码所在位置，
    // 放局部会撞 TDZ（虽然回调延迟执行时侥幸不报错，但依赖初始化顺序很脆弱）。
    let dragging = false, dragOffX = 0, dragOffY = 0;
    let dragStartX = 0, dragStartY = 0, dragPending = false;
    let moved = false;                 // 本轮是否真的越过阈值移动过（区分拖/点）
    let suppressExpandClickAt = 0;     // 最近一次「拖完」的时刻；click 在 350ms 内到达则忽略
    const DRAG_THRESHOLD = 4;

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
        // 进度条由隐藏变为显示，面板高度随之变化 —— 光环要立刻跟上，
        // 且进度条自身有展开过渡，结束后再补一次 sync（transitionend 不冒泡，
        // 只能直接监听进度条元素）。
        if (window.__ringSync) {
            try { window.__ringSync(); } catch (e) { }
            if (!p.__ringBound && window.__ringSync) {
                p.__ringBound = true;
                p.addEventListener('transitionend', () => {
                    try { window.__ringSync(); } catch (e) { }
                });
            }
        }
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
        p.querySelector('.pct').textContent = label ? (label + '' + v + '%') : (v + '%');
        const xb = $('dlr-ex-bar');
        if (xb) xb.style.width = v + '%';   // 收缩条进度同步
        // 光环跟随面板几何：进度条宽度变化、状态文案换行、折叠区展开收起
        // 都会改变面板尺寸，而那些并不一定触发面板自身的 transition，
        // 只靠 transitionstart 同步会让光环与面板错位。
        if (window.__ringSync) try { window.__ringSync(); } catch (e) { }
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
        appendLog('   标题:' + model.title +
            '  时长:' + (model.playbackDuration ? (model.playbackDuration / 1000).toFixed(1) + 's' : '未知'));
        appendLog('③ 拉取 m3u8 ...');
        const parsed = await fetchAndParseM3u8(model.playbackUrl, 0, wantRes);
        if (parsed.totalDur) {
            appendLog('   回放总时长 ' + fmtTime(parsed.totalDur) +
                ' (' + parsed.segments.length + ' 个切片)');
        }
        // 总时长一确定就把截取输入的单位上限摆出来（≥1 小时用 hh:mm:ss）
        if (onClipDur) onClipDur(parsed.totalDur || 0);
        // 单档 TS → 探测首片 SPS 得出原始分辨率（多档时分辨率来自变体 RESOLUTION 属性）
        let resInfo = null;
        if (!parsed.variants.length && !parsed.fmp4 && parsed.segments.length) {
            try {
                resInfo = await probeResolution(parsed.segments[0].url);
                if (resInfo) {
                    const profiles = { 77: 'Main', 66: 'Baseline', 100: 'High' };
                    const profile = profiles[resInfo.profileIdc] || ('profile' + resInfo.profileIdc);
                    appendLog('   原始分辨率 ' + resInfo.width + '×' + resInfo.height +
                        ' (H.264' + profile + ' @' + (resInfo.levelIdc / 10).toFixed(1) + ')');
                }
            } catch (e) { appendLog('   ⚠ 分辨率探测失败:' + e.message); }
        }
        prepCache = { key, at: Date.now(), token, model, parsed, resInfo };
        // 解析完成即后台预下载切片（v2.7.0）。不 await：解析阶段就该返回，
        // 预下载在后台自己跑，用户什么时候点下载都不影响。
        startPreDownload(roomId, liveUuid, wantRes, parsed);
        return prepCache;
    }

    // ---------- 解析阶段后台预下载（v2.7.0） ----------
    // 逐片静默拉取，弱并发（2）以免和用户正在做的事抢带宽；进度写到日志一行，
    // 不弹提示、不改进度条——它是后台行为，不该打扰用户。
    async function startPreDownload(roomId, liveUuid, wantRes, parsed) {
        if (!preEnabled() || !parsed || !parsed.segments || !parsed.segments.length) return;
        // fMP4 的 init 段与分片要按序取，弱并发下按顺序取即可，无需贪心调度
        const key = roomId + '|' + liveUuid + '|' + (wantRes || '');
        if (pre.key === key && pre.running) return;          // 已在跑
        if (pre.key === key && pre.want >= pre.total) return; // 已下完
        preReset(key, parsed.segments.length);
        pre.running = true;
        const segs = parsed.segments;
        const keyCache = {};
        let prevEnd = null;
        appendLog('   ⏬ 开始后台预下载 ' + segs.length + ' 个切片（可随时中断, 不影响稍后正式下载）');
        let next = 0, failed = 0;
        const worker = async () => {
            for (;;) {
                if (pre.stop) return;
                const i = next++;
                if (i >= segs.length) return;
                try {
                    const r = await downloadSegment(segs[i], keyCache, prevEnd);
                    prevEnd = r.end;
                    if (!pre.datas || pre.stop) return;
                    pre.datas[i] = r.bytes;
                    pre.want++; pre.bytes += r.bytes.length;
                } catch (e) {
                    // 单片失败不终止预下载：正式下载时它会被正常重试
                    failed++;
                }
            }
        };
        try { await Promise.all([worker(), worker()]); } catch (e) { }
        pre.running = false;
        if (pre.stop) {
            appendLog('   ⏹ 后台预下载已中断（已完成 ' + pre.want + '/' + pre.total + ' 片）');
            return;
        }
        if (pre.want >= pre.total) {
            appendLog('   ✓ 后台预下载完成 ' + pre.want + ' 片 · ' + fmtBytes(pre.bytes) +
                '，现在点下载只需合并保存');
        } else {
            appendLog('   ⏬ 后台预下载完成 ' + pre.want + '/' + pre.total + ' 片 · ' +
                fmtBytes(pre.bytes) + (failed ? '（' + failed + ' 片失败, 正式下载时会重试）' : ''));
        }
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
        if (!raw) throw new Error(label + ' 为空');
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
        throw new Error(label + ' 格式不对: 需要整段回放链接, 或"roomId liveUuid"一对');
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
                const r = parseQueueLine(raw, '第 ' + (i + 1) + '  行');
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
            appendLog('   文件名:' + baseName);
            progressSet(P.prep, '准备');

            // 截取：按时间区间筛切片（HLS 按切片边界对齐，非帧级精确）
            const clip = clipSegments(parsed.segments, opts.clipFrom, opts.clipTo);
            // 帧级截取需要完整切片集：它靠「第一片对应回放 0 秒」做时间轴基准，
            // 若这里就用裁过的切片，基准会错（第一片其实是区间中段而非开头），
            // 而且区间外的关键帧拿不到。所以启用时先按完整列表下载，最后再精裁。
            let frameClipWanted = false;
            try {
                const fv = GM_getValue('dlr_frameclip');
                frameClipWanted = (fv === undefined || fv === null) ? false : !!fv;
            } catch (e) { }
            // fMP4 没有 TS 包结构，帧级解析用不了
            const frameClipUsable = frameClipWanted && !parsed.fmp4 && opts.clipFrom !== null;
            const segs = frameClipUsable ? parsed.segments : clip.segs;
            if (clip.range) {
                appendLog('   ✂ 截取 ' + fmtTime(clip.range.from) + ' ~' + fmtTime(clip.range.to) +
                    ' → 切片对齐到 ' + fmtTime(clip.range.first) + ' ~' + fmtTime(clip.range.last) +
                    ' (' + clip.segs.length + '/' + parsed.segments.length + ' 切片)' +
                    (clip.range.clamped ? '; 结束时间超出总时长, 已自动截到回放末尾' : ''));
            }

            // fMP4：init + 分片本身就是合法 MP4，不需要 mux.js，输出必须是 .mp4
            const wantMp4 = opts.fmt === 'mp4' || parsed.fmp4;
            if (parsed.fmp4) appendLog('   检测到 fMP4 (#EXT-X-MAP /.m4s), 输出.mp4');
            const suffix = (opts.stamp ? '_' + stamp() : '');
            const clipTag = clip.range
                ? '_' + fmtTime(clip.range.from).replace(/:/g, '-') + '-' + fmtTime(clip.range.to).replace(/:/g, '-')
                : '';
            const plannedName = baseName + suffix + clipTag + (wantMp4 ? '.mp4' : '.ts');

            appendLog('   切片数:' + segs.length +
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
                            ' (单片 ' + fmtBytes(one) + ' ×' + segs.length + ' 片)');
                    }
                } catch (e) { /* 预估失败静默 */ }
            }
            // 抽样探测各片真实体积，供贪心调度排序（探不到就退回原序，不影响下载）
            if (segs.length >= 4) {
                try { segSizes = await probeSegSizes(segs, 6); } catch (e) { segSizes = null; }
            }
            progressSet(P.dlStart, '下载');
            setPhase('download');   // 进入下载阶段：收缩条转绿

            appendLog('④ 下载切片 (并发 ' + opts.threads + ', 重试 ' + opts.retry + ')...');
            const datas = new Array(segs.length);
            // 断点续传：命中同 key 的 partial 缓存则直接复用已下载切片
            const dlKey = roomId + '|' + liveUuid + '|' + (opts.res || '') +
                '|' + (clip.range ? clip.range.from + '-' + clip.range.to : 'full');
            let resumed = 0, resumedBytes = 0;
            // 先吃后台预下载：正式下载一开始就让预下载停下，避免两边同时拉同一片
            pre.stop = true;
            const preKey = roomId + '|' + liveUuid + '|' + (opts.res || '');
            // 只有「未设截取」时才整段命中——预下载下的是完整回放的片子，
            // 带区间裁剪时切片下标对不上，不能直接复用。
            if (!clip.range) {
                const hit = preTake(preKey);
                if (hit && hit.count) {
                    for (let i = 0; i < Math.min(hit.datas.length, segs.length); i++) {
                        if (hit.datas[i]) { datas[i] = hit.datas[i]; resumed++; resumedBytes += datas[i].length; }
                    }
                    if (resumed) {
                        appendLog('   ⏬ 命中后台预下载，已就绪 ' + resumed + '/' + segs.length +
                            ' 个切片 · ' + fmtBytes(resumedBytes) + '，无需重新下载');
                    }
                }
            }
            if (partial && partial.key === dlKey &&
                partial.datas && partial.datas.length === segs.length) {
                for (let i = 0; i < segs.length; i++) {
                    if (partial.datas[i]) { datas[i] = partial.datas[i]; resumed++; resumedBytes += datas[i].length; }
                }
                if (resumed) {
                    appendLog('   ♻ 命中断点缓存, 已恢复 ' + resumed + '/' + segs.length + '  个切片');
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
                            appendLog('   ♻ 命中跨会话断点缓存 (IndexedDB), 已恢复 ' +
                                resumed + '/' + segs.length + '  个切片');
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
                if (estTotal) label += ' ·' + fmtBytes(haveBytes) + '/' + fmtBytes(estTotal);
                if (speedBps > 0) label += ' ·' + fmtSpeed(speedBps);
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
                    appendLog('   调度: 贪心优先下大切片 (已抽样 ' + known + '/' + segs.length +
                        ' 片,' + fmtBytes(mn) + '~' + fmtBytes(mx) + '), 并发 ' +
                        SMART.min + '~' + SMART.max + ' 自适应');
                } else {
                    appendLog('   调度: 切片体积未知, 按原序下载, 并发自适应 ' + SMART.min + '~' + SMART.max);
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
                            if (done % 10 === 0 || done === segs.length) appendLog('' + done + '/' + segs.length);
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
                appendLog('   调度结束: 并发收敛于 ' + gov.value +
                    (gov.stats().lastSpeed ? ', 末速约 ' + fmtBytes(gov.stats().lastSpeed) + '/s' : ''));
            }

            // 中断/删除：保留（或清空）已下载切片供下次续传，本次不算失败
            if (DL.cancel) {
                const gotCount = datas.filter(Boolean).length;
                if (DL.purge) {
                    partial = null;
                    lastFailed = null;
                    try { await idbClearPartial(); } catch (e) { }
                    setStatus('🗑 已删除全部下载缓存 (' + gotCount + ' 片已放弃), 点下载将重新开始.');
                } else {
                    partial = { key: dlKey, datas: datas.slice() };
                    // 落盘 IndexedDB：刷新/关页后仍可断点续传
                    let persisted = false;
                    try { persisted = await idbPutPartial(dlKey, datas); } catch (e) { }
                    setStatus('⏹ 已中断: 已下载 ' + done + '/' + segs.length +
                        (persisted ? ' (已缓存到本地, 刷新后仍可断点续传)'
                                   : ' (已缓存, 点"下载本页回放"断点续传)'));
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
                if (allAuth) advice = '多为 auth_key 签名过期 (约 10 天有效), 刷新页面重新获取链接';
                else if (all404) advice = '切片已过期或被清理, 回放可能已失效';
                else advice = '可降低并发线程数后重试, 或点"检查更新"确认脚本为最新版';
                // 好片留存为断点缓存 + 记下失败片号：下次点下载只补这几片
                partial = { key: dlKey, datas: datas.slice(), failed: failures.slice() };
                lastFailed = failures.map((f) => f.index);
                try { await idbPutPartial(dlKey, datas); } catch (e) { }
                appendLog('❌' + failures.length + '/' + segs.length + ' 切片失败: #' + first.index + '' + first.reason);
                appendLog('   好片 ' + (segs.length - failures.length) + ' 片已保留为断点缓存,' +
                    '点"下载本页回放"只重试这 ' + failures.length + '  片');
                throw new Error(failures.length + '/' + segs.length + ' 切片失败 (#' + first.index + '' + first.reason + '). 建议:' + advice);
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
                const list = badIdx.map((i) => '#' + i).join('');
                partial = { key: dlKey, datas: datas.slice(), failed: badIdx.map((i) => ({
                    index: i, reason: '内容异常 (空或非 TS 结构)' })) };
                lastFailed = badIdx.slice();
                appendLog('❌ 完整性校验失败:' + list + ' 内容异常 (空数据或非 TS 结构)');
                throw new Error('完整性校验失败:' + list + ' 内容异常 (空数据或非 TS 结构),' +
                    '其余 ' + (segs.length - badIdx.length) + '/' + segs.length +
                    ' 片已保留为断点缓存, 点"下载本页回放"只补这些切片.');
            }
            const okBytes = datas.reduce((s, d) => s + (d ? d.length : 0), 0);
            appendLog('   ✅ 完整性校验通过:' + segs.length + '/' + segs.length +
                ' 片 ·' + fmtBytes(okBytes) +
                (parsed.fmp4 ? ' · fMP4' : ' · TS 同步字节正常'));
            partial = null;   // 全部下载成功，断点缓存失效
            try { await idbClearPartial(); } catch (e) { }
            lastFailed = [];

            // 帧级精确截取（实验性）：切片对齐的粗剪之后，把起止点修到关键帧。
            // 放在这里是因为需要全部切片已就位；失败则原样输出切片对齐的结果，
            // 不能因为「想更精确」反而让用户拿不到文件。
            let frameClipped = null;
            if (frameClipUsable && clip.range) {
                progressSet(P.mux, '帧级截取');
                appendLog('⑤ 帧级截取 (实验性)...');
                try {
                    const fromMs = clip.range.from * 1000;
                    const toMs = clip.range.to * 1000;
                    const segStarts = segs.map((sg) => sg.start || 0);
                    const r = clipFrames(datas, segs, segStarts, fromMs, toMs);
                    frameClipped = r;
                    appendLog('   ✂ 帧级对齐到关键帧:' + fmtTime(r.startKeyframeSec) +
                        ' 起, 共 ' + r.keyframes + ' 个关键帧可选 ' +
                        (r.injectedParams ? ' (已注入 SPS/PPS)' : ''));
                } catch (e) {
                    appendLog('   ⚠ 帧级截取失败 (' + e.message + '), 已退回切片对齐结果');
                    frameClipped = null;
                }
            }

            appendLog('⑤ 拼接 ...');
            progressSet(P.mux, '拼接');
            // 帧级截取成功后用精修后的字节流，否则用原切片数组。
            // 两者都是 Uint8Array[]，下游拼接逻辑完全一致。
            const outParts = frameClipped && frameClipped.bytes ? [frameClipped.bytes] : datas;
            let blob, outName = plannedName, note = '';
            if (parsed.fmp4) {
                try {
                    if (!parsed.initSegment) throw new Error('缺少 #EXT-X-MAP 初始化段地址');
                    const init = await getBinary(parsed.initSegment.url, null);
                    // 同样可能带 0xFFFFFFFF duration，一并修补
                    const fixed = fixMp4Duration(mergeBuffers([init, ...outParts]));
                    blob = new Blob([fixed], { type: 'video/mp4' });
                    appendLog('   fMP4 直接拼接成功 (init +' + datas.length + ' 分片)');
                } catch (e) {
                    note = ' (fMP4 初始化段下载失败:' + e.message + ', 已输出分片部分)';
                    blob = new Blob(outParts, { type: 'video/mp4' });
                }
            } else if (wantMp4) {
                try {
                    blob = await remuxToMp4(outParts);
                    appendLog('   MP4 转封装成功');
                } catch (e) {
                    note = ' (MP4 转封装失败, 已回退为 TS:' + e.message + ')';
                    blob = new Blob(outParts, { type: 'video/MP2T' });
                    outName = baseName + suffix + '.ts';
                }
            } else {
                blob = new Blob(outParts, { type: 'video/MP2T' });
            }
            if (note) appendLog('' + note);
            appendLog('   生成 ' + (blob.size / 1048576).toFixed(1) + ' MB');

            progressSet(P.save, '保存');
            appendLog('⑥ 保存文件 ...');
            await downloadBlob(blob, outName);
            // MP4 直接在面板内预览（TS 浏览器无法解码，不预览）
            if (wantMp4) {
                try { showPreview(blob, outName); } catch (e) { /* 预览失败不影响下载 */ }
            }
            setStatus('✅ 完成:' + outName + ' (已存入浏览器默认下载文件夹)');
            progressDone(true);
            diagRun(true, outName + ' · ' + fmtBytes(blob.size) + ' · ' + segs.length + '  片');
            lastRunResult = { ok: true, name: outName };
            notify('钉钉回放下载完成', outName + ' ·' + fmtBytes(blob.size), true);
        } catch (err) {
            setStatus('❌ 失败:' + err.message, true);
            progressDone(false);
            diagRun(false, String(err.message || '').split('\n')[0],
                lastFailed && lastFailed.length ? ('待重试片号: #' + lastFailed.slice(0, 30).join(' #')) : '');
            // 失败通知正文压到一行：系统通知窗口窄，整段错误详情留给面板历史
            const brief = String(err.message || '').split('\n')[0];
            notify('钉钉回放下载失败', brief.length > 120 ? brief.slice(0, 120) + '...' : brief, false);
        } finally {
            // 兜底复位：progressDone() 里有一堆 DOM 操作（进度条/spinner/光环），
            // 万一它自己抛错，DL.running 会永远停在 true —— 之后空格/Esc 快捷键全部
            // 失效、「删除已下载」也清不掉缓存，面板看起来「死了」。这里无条件复位。
            DL.running = false; DL.pause = false; DL.cancel = false;
            // 预下载的停止标志也要复位：正式下载时置 true 让它停下，
            // 但下一轮解析若不复位，startPreDownload 会直接 return、预下载再也不启动。
            pre.running = false;
            try { panel.classList.remove('dling'); } catch (e) { }
            try { const c = $('dlr-ctl'); if (c) c.style.display = 'none'; } catch (e) { }
            try { const pb = $('dlr-pause'); if (pb) pb.textContent = '⏸ 暂停'; } catch (e) { }
            goBtn.disabled = false;
            // 失败则亮出「只重试」按钮，成功/中断则按 lastFailed 现状刷新
            try { window.__renderRetryRow && window.__renderRetryRow(); } catch (e) { }
        }
    }

    // ---------- 初始化（等 body 就绪再挂载） ----------
    function init() {
        document.body.appendChild(panel);
        // 下载光环：挂在面板内、.body 的**兄弟位置**，尺寸交给 CSS（见 CSS 注释）。
        // 放在 .body 外面而不是里面：.body 有 background + overflow + 圆角，
        // 塞进去会被裁切或被半透明背景污染。
        const NS = 'http://www.w3.org/2000/svg';
        const ring = document.createElementNS(NS, 'svg');
        ring.id = 'dlr-ring';
        // pathLength 归一化：让 dasharray / dashoffset 成为与尺寸无关的比例值。
        // 实测 Chromium 的 <rect> 支持此属性，改变 width/height 后
        // getComputedStyle 的 stroke-dasharray 保持不变。
        ring.setAttribute('pathLength', '100');
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
        // 百分比几何：SVG 视口即面板盒子，rect 用百分比铺满。
        // 描边在 inset 之外半个线宽，与面板圆角自然贴合。
        [ringTrack, ringBeam].forEach(el => {
            el.setAttribute('x', '0'); el.setAttribute('y', '0');
            el.setAttribute('width', '100%'); el.setAttribute('height', '100%');
            el.setAttribute('rx', '3%'); el.setAttribute('ry', '3%');
            el.setAttribute('pathLength', '100');
        });
        // 光带占归一化周长的 28%，其余为透明缺口。数字固定，与面板尺寸无关。
        ringBeam.setAttribute('stroke-dasharray', '28 72');
        ring.appendChild(ringGrad);
        ring.appendChild(ringTrack);
        ring.appendChild(ringBeam);
        // 插到 .body 之前：同为面板的直接子元素，absolute 相对 #dlr-panel 定位。
        const bodyEl = panel.querySelector('.body');
        panel.insertBefore(ring, bodyEl);
        // 显隐：内联 opacity 优先级最高，不依赖样式表计算
        // （class 规则在本页面上曾出现「已匹配却算出 0」的坑）。
        const ringHide = () => { ring.classList.remove('on'); ring.style.opacity = '0'; };
        const ringShow = () => { ring.classList.add('on'); ring.style.opacity = '1'; };
        ringHide();
        // 不再有任何同步逻辑：尺寸/位置/圆角全部由 CSS 约束自动跟随。
        // __ringSync 保留为空实现，防止旧调用点抛错。
        const syncRing = () => {};
        window.__ringShow = ringShow;
        window.__ringHide = ringHide;
        window.__ringSync = syncRing;
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
        // 兜底展开高度：真实高度由 JS 实测写入，这个值只在实测前那一瞬生效，
        // 作用是「点开立刻有东西」，避免实测失败时展开成空白。
        const FALLBACK_H = 420;
        const setMore = (open) => {
            moreT.setAttribute('aria-expanded', open ? 'true' : 'false');
            moreB.classList.toggle('open', open);
            // 展开高度按内容实测后写内联 style。内联优先级高于样式表，不依赖
            // CSS 特异性计算（展开值被收起值压住是这个坑的教训）。
            //
            // 关键：不能在收起状态下直接读 scrollHeight——此时容器 height:0 +
            // overflow:hidden，内容被压扁，scrollHeight 恒为 0，于是永远写不进
            // 高度，展开动画也就不发生。先把约束临时解除再量，量完恢复。
            moreB.style.opacity = open ? '1' : '0';
            if (open) {
                // 先给兜底高度保证「立刻能看到东西」，再异步量真实高度修正。
                // 不能只靠 scrollHeight：字体未加载 / 内容尚未布局时会量到 0，
                // if (h > 0) 一旦不成立高度就永远写不进去，展开后是空白一片。
                moreB.style.height = FALLBACK_H + 'px';
                setTimeout(() => {
                    const prev = moreB.style.height;
                    moreB.style.height = 'auto';
                    const h = moreB.scrollHeight;
                    moreB.style.height = prev;
                    if (h > 0) moreB.style.height = h + 'px';
                }, 0);
            } else {
                moreB.style.height = '0px';
            }
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
        bindNum('dlr-retry-num', 'dlr_retry', 1, 10, 3);
        const thrTip = document.querySelector('#dlr-more-b .tip');
        if (thrTip) {
            thrTip.textContent = '并发已自动识别为 ' + autoThreads +
                ' 线程 (CPU 核心×2, 手动修改后以你的设置为准). 预取播放地址与切片索引, 打开页面后无需等待即可直接下载.';
        }
        bindChk('dlr-stamp', 'dlr_stamp', false);
        const prefetch = bindChk('dlr-prefetch', 'dlr_prefetch', true);   // 自动解析：默认开启
        // 完成/失败通知：提示音默认关（浏览器自动播放策略常拦默认开的声音，
        // 让人误以为坏了），系统通知默认开（无声、可靠、点一下能回面板）
        // 智能调度：默认开启。关掉后并发固定为上面设定的线程数。
        bindChk('dlr-smart', 'dlr_smart', true);
        // 帧级精确截取：默认关闭。切片边界对齐已能满足多数需求，帧级精修要
        // 多下一遍完整回放（依赖完整切片集建立时间轴基准），流量代价不小，
        // 所以交给用户按需开启——面板上有醒目提示告诉他在哪开。
        bindChk('dlr-frameclip', 'dlr_frameclip', false);
        // 拖动时自动收起「更多设置」/输出区（默认开）。拖拽逻辑读同一个键。
        bindChk('dlr-drag-collapse', 'dlr_drag_collapse', true);
        // 解析阶段后台预下载（v2.7.0）：默认开。开启后打开页面即在后台拉切片，
        // 用户点「下载」时几乎瞬间完成。关掉则行为与 2.6.x 完全一致。
        bindChk('dlr-predownload', 'dlr_predownload', true);

        // 截取区的「点这里打开帧级精确截取」：展开更多设置、滚到开关、闪两下。
        // 事件委托绑在 tip 容器上，而不是绑在链接自己身上。
        // 链接由 setClipTip() 在运行时生成（晚于此处执行），直接
        // getElementById('dlr-open-frameclip') 此刻拿到 null，绑定会静默失效；
        // 委托则无论链接何时重建都生效——applyClipUnit 每次改提示都会换新节点。
        const clipTipEl = $('dlr-clip-tip');
        if (clipTipEl) {
            clipTipEl.addEventListener('click', (e) => {
                const a = e.target.closest && e.target.closest('#dlr-open-frameclip');
                if (!a) return;
                e.preventDefault();
                const mt = $('dlr-more-t'), mb = $('dlr-more-b');
                if (mt && mb && !mb.classList.contains('open')) mt.click();
                const chk = $('dlr-frameclip');
                const lab = chk && chk.closest('.chk');
                if (lab) {
                    lab.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    lab.classList.remove('flash');
                    void lab.offsetWidth;      // 强制回流，让动画能重放
                    lab.classList.add('flash');
                    setTimeout(() => lab.classList.remove('flash'), 2400);
                }
            });
        }
        bindChk('dlr-notify-desktop', 'dlr_notify_desktop', false);
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
        // 待恢复的分辨率。**不能**在此处直接 resSel.value = GM 值：
        // 面板模板里 <select id="dlr-res"> 只有一个 value="" 的选项，
        // 赋一个不存在的值会被浏览器静默置空，随后 fillResOptions 读到的
        // 已经是空值 —— 保存的分辨率就这样每次刷新都丢掉（用户设 720p、
        // 实际下 1080p，且毫无提示）。改为先记下，等选项建好后再套用。
        let pendingRes = '';
        try { pendingRes = GM_getValue('dlr_res') || ''; } catch (e) { }
        // 上一次的有效选择：用户点「自定义…」后取消/输错时要回到这里，而不是留下哨兵值
        let lastValidRes = '';
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
                ? '自动 (原始分辨率 ' + resInfo.width + '×' + resInfo.height + ')'
                : '自动 (原始分辨率)';
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
                addOpt(v.res, v.res + ' ·' + Math.round(v.bandwidth / 1000) + ' kbps');
            });
            // 常用档位里还没出现过的（≤ 原始分辨率）也列出来，方便一键降档
            COMMON_RES.forEach((c) => {
                const key = c.w + 'x' + c.h;
                if (declared.some((v) => v.res === key)) return;
                if (ow && oh && (c.w > ow || c.h > oh)) return;   // 比原始还大，不列
                if (!ow && !oh) return;                            // 未知原始分辨率时不猜
                addOpt(key, key + (declared.length ? ' (按最接近档位)' : ''));
            });
            // 自定义入口永远在最后
            addOpt(CUSTOM_RES, '自定义... (手动输入宽×高)');
            // 恢复优先级：本次刷新前保存的值 > 本次填充前的当前值。
            // pendingRes 在初始化时存的是 GM 值；fillResOptions 也可能在
            // 用户已手动选过档位之后被再次调用（预取完成后回填），那时
            // cur 才是应该保留的当次选择。
            const want = pendingRes || cur;
            resSel.value = want;   // 不存在则浏览器回落"自动"
            if (resSel.value !== want) pendingRes = '';   // 该档位在本片里不存在
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
                    setStatus('❌' + e.message, true);
                    resSel.value = lastValidRes;
                    return;
                }
                // 解析成播放列表里真实存在的档位；没有则如实说明并回落自动
                const hit = pickResVariant(prepCache && prepCache.parsed && prepCache.parsed.variants,
                    normalized,
                    prepCache && prepCache.resInfo ? prepCache.resInfo.width : 0,
                    prepCache && prepCache.resInfo ? prepCache.resInfo.height : 0);
                if (!hit) {
                    setStatus('⚠ 没有不超过原始分辨率且接近 ' + normalized + ' 的档位, 已回到"自动"', true);
                    resSel.value = '';
                    try { GM_setValue('dlr_res', ''); } catch (e) { }
                    return;
                }
                resSel.value = hit.res;
                // 播放列表里没有正好等于输入值的档位时必须说清楚——
                // 否则用户以为下了 999x999，其实是 1280x720。
                if (hit.res !== normalized) {
                    setStatus('ℹ 播放列表里没有 ' + normalized + ', 实际使用最接近的档位 ' +
                        hit.res + ' (' + Math.round(hit.bandwidth / 1000) + ' kbps)');
                } else {
                    setStatus('ℹ 已选择 ' + hit.res +
                        ' (' + Math.round(hit.bandwidth / 1000) + ' kbps)');
                }
            }
            lastValidRes = resSel.value;
            pendingRes = resSel.value;   // 用户手动改过，后续回填以它为准
            try { GM_setValue('dlr_res', resSel.value); } catch (e) { }
            // 切换分辨率 → 缓存键不同，直接重新预取，下载时秒用
            let p = null;
            try { p = parseUrl(($('dlr-url').value || '').trim() || location.href); } catch (e) { }
            if (p && prefetch.checked) {
                setStatus('⏳ 已切换分辨率, 重新预取...');
                // 自定义档位的「实际用了哪一档」提示要留在历史里，
                // 否则会被下面这条「就绪」覆盖掉，用户就不知道自己填的值被换掉了
                const picked = resSel.value;
                prep(p.roomId, p.liveUuid, picked).then(() => {
                    if (window.__updateNameTip) window.__updateNameTip();
                    if (fillResOptions) fillResOptions(prepCache.parsed.variants, prepCache.resInfo);
                    const res = prepCache.parsed.segments.length + '  个切片';
                    const pickedLabel = picked ? ',' + picked : '';
                    setStatus('✅ 就绪 ·' + (prepCache.model.title || '未命名') +
                        ' · ' + res + pickedLabel + ', 可开始下载');
                }).catch((e) => setStatus('⚠ 预取失败:' + e.message, true));
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
                : (prefetch.checked ? '回放标题解析中...' : '留空将使用回放标题');
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
                const label = updSrcSel.options[updSrcSel.selectedIndex].textContent.split(' (')[0];
                setStatus('ℹ 更新源已切换为 ' + label + ', 正在重新检查...');
                // 立即按新源重查一次：换源后继续拿旧源的结论没有意义。
                // remoteVersion / UPD 在下方定义，这里用 setTimeout 延到本轮之后。
                setTimeout(async () => {
                    try {
                        const v = await remoteVersion();
                        if (compareVersions(v, VERSION) > 0) {
                            showFound(v);
                            setStatus('🔄 发现新版 ' + v + ' (当前 ' + VERSION + ' ), 点击"发现新版"跳转下载页');
                        } else {
                            setStatus('✅ 已是最新版 v' + VERSION + ' (更新源:' + label + ')');
                            setUpd('已是最新');
                        }
                    } catch (e) {
                        setStatus('⚠ 新更新源不可达:' + e.message, true);
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
                onload: (r) => (r.status >= 200 && r.status < 300) ? res(r.responseText) : rej(new Error('HTTP' + r.status)),
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
            pushHistory(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '' + msg);
            };
        const showFound = (v) => {
            UPD.found = v;
            setUpd('发现新版 ' + v + ' ↑', true);
            upd.title = '发现新版 ' + v + ' (当前 ' + VERSION + ' ), 点击打开更新页';
            };
        // 点击：空闲=检查；已发现新版=跳转下载页；检查中=忽略
        upd.addEventListener('click', async () => {
            if (UPD.busy) return;
            if (UPD.found) {
                setStatus('🔄 已打开更新页 v' + UPD.found + ' (当前 ' + VERSION + ' ), 在油猴里确认更新即可');
                window.open(updatePageUrl(), '_blank');
                return;
            }
            clearTimeout(UPD.timer);
            UPD.busy = true;
            setUpd('检查中...');
            try {
                const v = await remoteVersion();
                if (compareVersions(v, VERSION) > 0) {
                    showFound(v);
                    setStatus('🔄 发现新版 ' + v + ' (当前 ' + VERSION + ' ), 点击"发现新版"跳转下载页');
                } else {
                    setStatus('✅ 已是最新版 v' + VERSION);
                    setUpd('已是最新');
                    UPD.timer = setTimeout(() => setUpd(UPD_IDLE), 2600);
                }
            } catch (e) {
                setStatus('❌ 检查更新失败:' + e.message, true);
                setUpd('失败');
                UPD.timer = setTimeout(() => setUpd(UPD_IDLE), 2600);
            } finally {
                UPD.busy = false;
                upd.title = UPD.found
                    ? ('发现新版 ' + UPD.found + ' , 点击打开更新页')
                    : '检查更新; 发现新版后点击跳转下载页';
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
                        quietLog('🔄 自动检查: 发现新版 ' + v + ' (当前 ' + VERSION + ' ), 点击"发现新版"跳转下载页');
                    } else {
                        quietLog('检查更新: 已是最新版 v' + VERSION);
                    }
                } catch (e) {
                    quietLog('检查更新 (自动) 失败:' + e.message);
                } finally {
                    UPD.busy = false;
                }
            }, 1600);
        }

        // 收缩 / 展开：不用时缩成一个小图标，状态持久化
        // 宽度/内边距/圆角为定值可直接补间；内容用 opacity 淡出，高度随内容塌缩
        const applyMini = () => {
        panel.classList.toggle('mini', miniState);
        // 收起态横条的高度用内联写入（内联必胜样式表，避开特异性竞争）。
        const ex = panel.querySelector('.expand');
        if (ex) {
            if (miniState) {
                // 兜底 + 实测修正，同 setMore（实测失败时不能是空白）
                ex.style.opacity = '1';
                ex.style.height = '48px';
                setTimeout(() => {
                    const prevH = ex.style.height;
                    ex.style.height = 'auto';
                    const h = ex.scrollHeight;
                    ex.style.height = prevH;
                    if (h > 0) ex.style.height = h + 'px';
                }, 0);
            } else {
                ex.style.opacity = '0';
                ex.style.height = '0px';
            }
        }
    };
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
        exp.addEventListener('click', () => {
            // 刚拖完就松手的那一下 click 不算「点开」——否则拖一下面板就弹开了。
            if (suppressExpandClickAt && Date.now() - suppressExpandClickAt < 350) {
                suppressExpandClickAt = 0;
                return;
            }
            setMini(false);
        });
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
            setStatus(DL.pause ? '⏸ 已暂停: 进度已保留, 点"▶ 继续"恢复下载'
                              : '▶ 继续下载中...');
        });
        const cancelBtn = $('dlr-cancel');
        cancelBtn && cancelBtn.addEventListener('click', () => {
            pre.stop = true;                 // 正式下载中断时，后台预下载也一并停掉
            if (!DL.running) {
                appendLog('⏹ 已中断后台预下载');
                return;
            }
            DL.cancel = true;
            setStatus('⏹ 正在停止... (已下载切片会保留, 可断点续传)');
        });
        const purgeBtn = $('dlr-purge');
        purgeBtn && purgeBtn.addEventListener('click', () => {
            if (DL.running) {
                DL.purge = true;
                DL.cancel = true;
                setStatus('🗑 正在清空全部已下载切片...');
            } else {
                partial = null;
                preReset(null, 0);            // 「删除已下载」同时清掉预下载缓存
                lastFailed = null;
                renderRetryRow();
                idbClearPartial().catch(() => {});   // 非 async 回调，fire-and-forget
                setStatus('🗑 下载缓存已清空, 下次下载将从头开始');
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
                const head = lastFailed.slice(0, 12).map((i) => '#' + i).join('');
                info.textContent = '上次失败 ' + n + ' 片 (' + head +
                    (n > 12 ? '...' : '') + ' ), 其余切片已缓存';
            }
        };
        window.__renderRetryRow = renderRetryRow;   // 供下载流程在状态变化时刷新
        const retryBtn = $('dlr-retry');
        retryBtn && retryBtn.addEventListener('click', () => {
            if (DL.running || !lastFailed || !lastFailed.length) return;
            setStatus('♻ 正在重试 ' + lastFailed.length + ' 个失败切片...');
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
                const blob = new Blob(['\uFEFF' + text], { type:'text/plain;charset=utf-8' });
                await downloadBlob(blob, filename);
                appendLog('📋 诊断日志已导出:' + filename);
                setStatus('📋 已导出诊断日志 ' + filename);
            } catch (e) {
                setStatus('❌ 导出诊断日志失败:' + e.message, true);
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
                setStatus('⚠ 尚未解析到切片列表, 请先点"下载本页回放"或等预取完成', true);
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
                appendLog('📄 已导出 m3u8:' + filename + ' (' + n + ' 片 ' +
                    (prepCache.parsed.encrypted ? ' · AES-128' : '') +
                    (prepCache.parsed.fmp4 ? ' · fMP4' : '') + ')');
                setStatus('📄 已导出 ' + filename + ' (' + n + ' 片)');
            } catch (e) {
                setStatus('❌ 导出 m3u8 失败:' + e.message, true);
            } finally {
                m3u8Btn.disabled = false;
                m3u8Btn.textContent = oldText;
            }
        });

        // ---------- 队列 UI ----------
        // 三个 q* 变量原先漏了 const（逗号续行时只有第一项带声明），
        // 于是它们会变成隐式全局变量并污染共享作用域。
        const qBox = $('dlr-queue'), qRow = $('dlr-queue-ctl'),
            qGo = $('dlr-queue-go'), qClear = $('dlr-queue-clear'),
            qInfo = $('dlr-queue-info');
        const renderQueue = () => {
            const { out, errs } = parseQueueInput(qBox.value);
            if (!qRow) return;
            const n = out.length;
            qRow.style.display = (n || errs.length) ? 'flex' : 'none';
            if (!n && !errs.length) return;
            let msg = n ? (n + '  个回放待下载') : '';
            if (errs.length) msg += (msg ? ';' : '') + errs.length + '  行无法识别';
            if (qInfo) qInfo.textContent = msg;
        };
        qBox && qBox.addEventListener('input', renderQueue);
        qBox && qBox.addEventListener('change', renderQueue);

        // ---------- 面板拖拽 + 键盘快捷键（v2.4.0） ----------
        // 位置持久化：只存用户拖过之后的坐标；没拖过就保持 CSS 的右下角默认位，
        // 这样窗口变小/变大时默认位依然正确（存死坐标会在小窗口下越界）。
        const POS_KEY = 'dlr_pos';



        // 最近一次生效的视口坐标。窗口缩放后要靠它重新钳制 —— 拖过的面板用的是
        // 存下来的 left/top 定值，窗口一小就跑到屏幕外去了（见下面的 resize 处理）。
        let lastPos = null;
        const applyPos = (x, y) => {
            const r = panel.getBoundingClientRect();
            const p = posToRightBottom(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
            panel.style.left = p.left;
            panel.style.top = p.top;
            panel.style.right = p.right;
            panel.style.bottom = p.bottom;
            // 记下**钳制后**的坐标：下一轮 resize 要以它为基准，否则误差会逐次累积
            lastPos = { x: parseFloat(p.left) || 0, y: parseFloat(p.top) || 0 };
        };
        // 窗口缩放后重新钳制面板位置。
        // 缺陷表现：把面板拖到最右再缩小窗口，面板会有一大半跑到屏幕外
        // （实测 1400px 窗口拖到右缘，缩到 760px 后 392px 宽的面板有 240px 在屏幕外，
        //  占 -61%），而且**鼠标再也点不到它**——elementFromPoint 在任何可见位置都
        // 返回不到面板，用户只能刷新页面找回。clampPanelPos 本来就有防越界的钳制，
        // 只是缩放后没人再调用它。这里按上次的坐标重跑一次 applyPos 即可。
        window.addEventListener('resize', () => {
            try {
                if (lastPos) applyPos(lastPos.x, lastPos.y);
            } catch (e) { }
        });
        const restorePos = () => {
            const raw = GM_getValue(POS_KEY, '');
            if (!raw) return;
            const m = String(raw).match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
            if (!m) return;
            applyPos(parseFloat(m[1]), parseFloat(m[2]));
        };
        // 拖拽把手有两个：展开态是标题区(.bin)，收起态是横条(.expand)。
        // 只绑一个的话，收起后就抓不到东西了——用户反馈的正是这个。
        const handles = panel.querySelectorAll('.drag');
        // 「拖拽时自动收起更多设置与输出区」——可关。拖着面板时那些折叠区
        // 只会碍事（还可能拖动过程中误触展开动画），默认自动收起。
        let autoCollapseOnDrag = true;
        try {
            const av = GM_getValue('dlr_drag_collapse');
            if (av !== undefined && av !== null) autoCollapseOnDrag = !!av;
        } catch (e) { }
        // 勾选变化立刻生效，不必刷新页面
        const dragCollapseChk = $('dlr-drag-collapse');
        if (dragCollapseChk) {
            dragCollapseChk.addEventListener('change', () => {
                autoCollapseOnDrag = dragCollapseChk.checked;
            });
        }
        const collapseForDrag = () => {
            if (!autoCollapseOnDrag) return;
            const mt = $('dlr-more-t'), mb = $('dlr-more-b');
            if (mt && mb && mb.classList.contains('open')) {
                mb.dataset.preDragOpen = '1';
                setMore(false);
            }
            // 预览区直接隐藏（有内容时它会自己撑高，留着反而碍事），
            // 但记下原值，拖完恢复——不能一拖就永久消失。
            const pv = $('dlr-preview');
            if (pv && pv.classList.contains('show')) {
                pv.dataset.preDragShown = '1';
                pv.classList.remove('show');
                pv.style.height = '0px';
            }
        };
        // 只有落在「控件之外」的按下才开始拖拽。
        // 这条很关键：拖拽区 .bin 包住了整个表单（链接框/文件名/分辨率/截取…），
        // 若不区分就一律 preventDefault，区域内所有输入框和下拉框都收不到焦点，
        // 整个面板变成「只能看不能改」——用户实测反馈的正是这个问题。
        // 排除「表单控件」和「收起/展开按钮」——它们各自有原生交互，不能被拖拽劫持。
        // 注意不能把 .expand 写进排除表：它本身就是收起态的拖拽把手，
        // 排除掉会让收起后完全拖不动（这正是 2.4.0 的 bug）。
        // 只在「不是把手自身」时才排除：点横条 = 拖动，横条内的 .collapse 才排除。
        const onControl = (t, self) => {
            if (!t) return false;
            if (t.closest('input,select,textarea,button,a,label,[contenteditable="true"]')) return true;
            const c = t.closest('.collapse');
            return !!c;
        };
        handles.forEach((handle) => {
            handle.addEventListener('mousedown', (e) => {
                // 只认左键；别抢输入框/按钮上的手势
                if (e.button !== 0) return;
                // 落在控件上 → 完全不管，浏览器原生行为（聚焦、展开下拉）照旧
                if (onControl(e.target, handle)) return;
                // 收起态横条上单击是「展开」，拖动阈值内不算拖——否则
                // 用户想点开面板却因为手抖而移动了它。
                if (panel.classList.contains('mini')) {
                    dragStartX = e.clientX; dragStartY = e.clientY;
                    dragPending = true;
                }
                const r = panel.getBoundingClientRect();
                dragging = true;
                moved = false;
                dragOffX = e.clientX - r.left;
                dragOffY = e.clientY - r.top;
                collapseForDrag();
                panel.classList.add('dragging');
                e.preventDefault();   // 防止拖出文字选中 / 触发原生拖拽
            });
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (dragPending) {
                const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
                if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
                dragPending = false;   // 越过阈值，这次 mousemove 才是真拖拽
            }
            applyPos(e.clientX - dragOffX, e.clientY - dragOffY);
            moved = true;
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            dragPending = false;
            panel.classList.remove('dragging');
            // 恢复拖拽时被折叠的更多设置与预览区
            const mb2 = $('dlr-more-b');
            if (mb2 && mb2.dataset.preDragOpen === '1') { setMore(true); delete mb2.dataset.preDragOpen; }
            const pv2 = $('dlr-preview');
            if (pv2 && 'preDragShown' in pv2.dataset) {
                pv2.classList.add('show');
                const prevH2 = pv2.style.height;
                pv2.style.height = 'auto';
                const hh = pv2.scrollHeight;
                pv2.style.height = prevH2 || '0px';
                if (hh > 0) pv2.style.height = hh + 'px';
                delete pv2.dataset.preDragShown;
            }
            const r = panel.getBoundingClientRect();
            // 必须 try 保护：这里若抛错会跳过下面的 suppressExpandClickAt 赋值，
            // 结果是「拖完面板反而弹开」。
            try { GM_setValue(POS_KEY, Math.round(r.left) + ',' + Math.round(r.top)); }
            catch (e) { }
            // 拖过之后不要再触发横条的「点击展开」——否则拖一下就弹开了。
            // 用时间戳而不是标志位：click 事件紧跟 mouseup 在同一轮派发，
            // setTimeout(...,0) 清标志的回调会先跑，导致标志提前失效。
            suppressExpandClickAt = moved ? Date.now() : 0;
        });

        // 快捷键：一律带 modifier 或用安全键，避免和输入法/网页快捷键打架。
        // 输入框、textarea、可编辑区里不拦截——用户正在打字不能被抢键。
        // 用 DL.running 而不是看按钮显隐来判断状态：面板收起时 dlr-ctl 不可见，
        // 但下载确实在跑——只看显隐会让空格在收起状态下误触发「开始下载」。
        const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        window.addEventListener('keydown', (e) => {
            if (typing(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
            const k = e.key;
            if (k === 'Escape') {
                // Esc：下载中先中断（最需要立刻能停），否则收起/展开面板
                if (DL.running) {
                    const cancelBtn = $('dlr-cancel');
                    if (cancelBtn) cancelBtn.click();
                } else {
                    setMini(!panel.classList.contains('mini'));
                }
                e.preventDefault();
                return;
            }
            // 浏览器给空格键的 e.key 是**含一个空格字符**的 ' '，不是空串；
            // 'Spacebar' 是 IE/EdgeHTML 时代的旧值。原先只比 k === '' 与 k === 'Spacebar'，
            // 两个分支都命不中 —— 空格快捷键自 v2.4.0 引入起就从未生效过。
            if (k === ' ' || k === '' || k === 'Spacebar') {
                // 空格：空闲时开始下载；下载中暂停/继续（同一键随状态切换）
                if (DL.running) {
                    const p = $('dlr-pause');
                    if (p) p.click();
                } else {
                    $('dlr-go').click();
                }
                e.preventDefault();
                return;
            }
            if (k && k.toLowerCase() === 'm') {
                setMini(!panel.classList.contains('mini'));
                e.preventDefault();
            }
        });
        restorePos();

        // ---------- 截取时间输入：单位上限跟随回放总时长（v2.3.0） ----------
        // 时长未知时只规范化已填文本；解析出总时长后才知道该不该用 hh:mm:ss。
        let clipUnit = 'mm:ss';
        // 提示行结构拆成三段：纯文本 + 跳转链接 + 纯文本尾巴。
        // 不能用 tip.textContent = ... 整体覆写——那会把里面的 <a> 一起替换掉，
        // 链接会在启动时被无声抹掉（textContent 赋值会连子节点一起干掉）。
        const setClipTip = (durText) => {
            const tip = $('dlr-clip-tip');
            if (!tip) return;
            tip.textContent = durText ? durText + '' : '';
            const a = document.createElement('a');
            a.href = '#';
            a.id = 'dlr-open-frameclip';
            a.style.cssText = 'color:#6f9bff;cursor:pointer;text-decoration:underline';
            a.textContent = '点这里打开"帧级精确截取"';
            tip.appendChild(a);
            tip.appendChild(document.createTextNode('——在"更多设置"里, 开启后会先下载完整回放再裁剪, 流量更多.'));
        };
        const applyClipUnit = (totalDurSec) => {
            const hint = clipTimeHint(totalDurSec);
            clipUnit = hint.unit;
            const fromEl = $('dlr-from'), toEl = $('dlr-to');
            if (fromEl) fromEl.placeholder = '开始 ' + hint.unit;
            if (toEl) toEl.placeholder = '结束 ' + hint.unit;
            setClipTip(hint.capHint
                ? '留空为整段; 本回放总时长 ' + hint.capHint + ', 可填到 ' + hint.unit + '.'
                : '留空为整段. 当前按切片边界对齐 (约 30 秒粒度). 想要帧级精度？');
            [fromEl, toEl].forEach((el) => {
                if (el && el.value) el.value = normalizeClipText(el.value, clipUnit);
            });
        };
        onClipDur = applyClipUnit;
        applyClipUnit(0);
        ['dlr-from', 'dlr-to'].forEach((id) => {
            const el = $(id);
            // blur 时规范化（不在 input 时改写，否则边打边被补零很烦）
            el && el.addEventListener('blur', () => { el.value = normalizeClipText(el.value, clipUnit); });
        });
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
                appendLog('⚠ 队列有 ' + errs.length + ' 行无法识别:');
                errs.slice(0, 5).forEach((m) => appendLog('' + m));
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
            appendLog('▶ 队列开始: 共 ' + Q.items.length + '  个回放, 顺序执行');
            try {
                for (let i = 0; i < Q.items.length; i++) {
                    if (DL.cancel) { appendLog('⏹ 队列已被中断, 剩余 ' + (Q.items.length - i) + '  个未执行'); break; }
                    Q.current = i;
                    const it = Q.items[i];
                    setStatus('队列 ' + (i + 1) + '/' + Q.items.length + ' · 正在处理...');
                    appendLog('—— 队列 [' + (i + 1) + '/' + Q.items.length + ']' +
                        (it.roomId ? 'roomId=' + it.roomId + '' : '') + 'liveUuid=' + it.liveUuid);
                    let itemErr = '';
                    try {
                        await run(it.roomId, it.liveUuid, {
                            res: resSel.value,
                            fmt: $('dlr-fmt').value,
                            threads: parseInt($('dlr-thread').value, 10) || 8,
                            retry: parseInt($('dlr-retry-num').value, 10) || 3,
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
                        appendLog('❌ 队列 [' + (i + 1) + '] 失败:' + reason);
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
                let summary = '🏁 队列结束: 成功 ' + done;
                if (bad) summary += ' · 失败 ' + bad;
                if (skipped > 0) summary += ' · 未执行 ' + skipped;
                appendLog(summary);
                if (okList.length) {
                    appendLog('   ✅' + okList.map((o) => o.name || o.liveUuid).slice(0, 8).join(',') +
                        (okList.length > 8 ? ' 等 ' + okList.length + '  个' : ''));
                }
                failList.slice(0, 5).forEach((f) => appendLog('   ❌' + f.liveUuid + '' + f.err));
                setStatus(summary + (bad ? ' (点状态栏看详情)' : ''), bad > 0);
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
                setStatus('❌ 截取时间错误:' + e.message, true);
                return;
            }
            const opts = {
                fmt: $('dlr-fmt').value,
                threads: Math.max(1, Math.min(16, parseInt($('dlr-thread').value, 10) || 5)),
                retry: Math.max(1, Math.min(10, parseInt($('dlr-retry-num').value, 10) || 3)),
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
                setStatus('❌' + e.message, true);
            }
        });

        try {
            const p = parseUrl(location.href);
            $('dlr-url').value = location.href;
            setStatus('检测到回放 · roomId=' + p.roomId + ' · liveUuid=' + p.liveUuid.slice(0, 8) + '...');
            // 预解析：检测到回放页且开关开启时，后台先跑 csrf/播放地址/m3u8，
            // 点下载直接进入切片阶段。失败不打扰用户，状态栏提示即可。
            if (prefetch.checked) {
                setStatus('⏳ 正在预取播放地址与切片索引...');
                prep(p.roomId, p.liveUuid, resSel.value).then(() => {
                    if (window.__updateNameTip) window.__updateNameTip();
                    if (fillResOptions) fillResOptions(prepCache.parsed.variants, prepCache.resInfo);
                    setStatus('✅ 就绪 ·' + (prepCache.model.title || '未命名') +
                        ' · ' + prepCache.parsed.segments.length + '  个切片, 可开始下载');
                }).catch((e) => {
                    setStatus('⚠ 预取失败:' + e.message + ' (点击下载将重新获取)', true);
                });
            } else {
                setStatus('检测到回放 · roomId=' + p.roomId +
                    ' · liveUuid=' + p.liveUuid.slice(0, 8) + '... · 点击"下载本页回放"');
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
