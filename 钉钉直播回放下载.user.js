// ==UserScript==
// @name         钉钉直播回放下载器（免登录）
// @namespace    dingtalk.live.replay
// @version      3.5.2
// @description  钉钉直播回放下载器：免登录抓取 m3u8，支持 MP4(默认,已修时长/进度条)/TS、截取时长、面板内嵌侧栏(实验性)、发送到 aria2(实验性)、智能调度（贪心优先+并发自适应）、帧级精确截取(实验性)、下载队列、自定义分辨率、完成/失败通知与提示音、失败切片单独重试、导出 m3u8 与诊断日志、毛玻璃面板、收缩为图标、并发与重试、多码率、AES-128、fMP4、进度动画。
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
// @connect      127.0.0.1
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
    // 本机实测 (aria2 1.37.0 便携版, 真实 RPC 调用) 确认的事实:
    //   端点 /jsonrpc, 必须 POST (GET 报 Invalid Request);
    //   密钥作为 params[0] = "token:<secret>", aria2 先摘前缀再校验;
    //   所有数字都返回 JSON 字符串 (无 float) → 后面 parseInt 不可省;
    //   失败统一 {error:{code,message}}, 坏 token 报 Unauthorized。
    // 安全基线: 只连 127.0.0.1 + 密钥。**不要**让用户单独开 --rpc-allow-origin-all:
    // 源码上它不校验 Origin/Host, 且 JSONP 与 JSON 同一码路, 任何网页都能用
    // dir/out 往任意路径写文件。
    const ARIA2_HOST_DEF = '127.0.0.1';
    const ARIA2_PORT_DEF = 6801;
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

    // ---------- 聊天记录接口 (v3.5.0, 实验性) ----------
    // 签名是实测出来的: GET + loadMoreId(必填,可空串) + sortType(必填整数)。
    // POST → 405; 缺 sortType 或 loadMoreId → 400 并在 message 里点名缺哪个。
    // 登录态下浏览器内真实请求仍返回 errorCode 19004「游客身份失效」——
    // 该接口要的不是网页登录态, 所以这里如实抛出, 不伪造内容。
    const CHAT_URL = 'https://lv.dingtalk.com/live/listComment';
    async function fetchChatPage(roomId, liveUuid, loadMoreId) {
        const qs = 'roomId=' + encodeURIComponent(roomId) +
            '&liveUuid=' + encodeURIComponent(liveUuid) +
            '&loadMoreId=' + encodeURIComponent(loadMoreId || '') +
            '&sortType=1&size=' + CHAT_PAGE_SIZE;
        const r = await gmx({ method: 'GET', url: CHAT_URL + '?' + qs, cookie: '' });
        let j;
        try { j = JSON.parse(r.response); } catch (e) {
            throw new Error('接口返回的不是 JSON (HTTP ' + r.status + ')');
        }
        if (j && j.success === false) {
            const code = j.errorCode || '';
            const msg = j.errorMsg || '未知错误';
            if (String(code) === '19004') {
                throw new Error('钉钉拒绝了该请求（19004 ' + msg + '）—— '
                    + '这个聊天接口不认网页登录态, 目前拿不到内容; 面板不会编造数据');
            }
            throw new Error('接口错误 ' + code + ': ' + msg);
        }
        return j && (j.result || j.data || j);
    }
    // 按 loadMoreId 游标翻页, 最多 maxPages 页; 返回规范化后的消息数组。
    async function fetchAllChat(roomId, liveUuid, maxPages) {
        const all = [];
        let cursor = '';
        const cap = maxPages || 20;
        for (let p = 0; p < cap; p++) {
            const page = await fetchChatPage(roomId, liveUuid, cursor);
            const batch = chatNormalize(page);
            const rawList = (page && (page.commentList || page.comments || page.list)) || [];
            all.push(...batch);
            // 拿不到新的游标就停: 重复游标说明服务端不再给新数据
            const next = (page && (page.loadMoreId || (page.result && page.result.loadMoreId))) || '';
            if (!rawList.length || !next || next === cursor) break;
            cursor = next;
        }
        return all;
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
    // 把 left/top 坐标钳制成可写入的定位值。
    //
    // v3.2.1 起**只返回 left/top**：过去还把坐标反算成 right/bottom 像素值一并写入，
    // 于是 top 和 bottom 同时存在 —— CSS 对「height:auto + top + bottom」会把高度钉成
    // 「视口高 − top − bottom」，悬浮收起态实测 shell 高 570px 而内容只有 48px，
    // 一块看不见的大壳子盖住右下角、把点击全吃掉。改成只锚定 left/top 后，
    // shell 高度始终等于内容高度；窗口缩放仍由 resize 里按 lastPos 重跑 applyPos
    // 兜住（v3.0.3 的钳制逻辑不变，只夹 x 不夹 y 的策略也不变）。
    function posToRightBottom(x, y, w, h, vw, vh) {
        const c = clampPanelPos(x, y, w, h, vw, vh);
        return {
            left: c.x + 'px',
            top: c.y + 'px',
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
        return { unit: unit, capHint: has ? fmtTime(dur) : null };
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
    // ---------- 聊天记录导出（v3.5.0, 实验性） ----------
    // 接口实测结论（2026-10-05 登录态, 浏览器内带完整 cookie 真实请求）:
    //   GET https://lv.dingtalk.com/live/listComment
    //       ?roomId=…&liveUuid=…&loadMoreId=（必填, 可空串）&sortType=（必填整数）&size=…
    //   → 参数齐了返回 200, 但 body 是 {"success":false,"errorCode":"19004",
    //     "errorMsg":"游客身份失效，请尝试刷新页面"} —— 即使浏览器里已登录、csrf/XSRF 齐全、
    //     cookie 带上也一样。所以这个接口不接受「网页登录态」这一种身份, 我们如实报错,
    //     不伪造任何聊天内容。签名是对探出来的: POST 是 405, 缺 sortType/loadMoreId 各 400。
    const CHAT_PAGE_SIZE = 50;
    // 把一条评论摊平成稳定字段顺序 —— 各格式共用同一份规范化结果, 避免四套解析各写一遍。
    function chatNormalize(raw) {
        const pick = (o, keys) => {
            for (let i = 0; i < keys.length; i++) {
                const v = o[keys[i]];
                if (v !== undefined && v !== null && v !== '') return v;
            }
            return '';
        };
        const out = [];
        const arr = Array.isArray(raw) ? raw : (raw && (raw.commentList || raw.comments || raw.list)) || [];
        for (let i = 0; i < arr.length; i++) {
            const c = arr[i] || {};
            const timeRaw = pick(c, ['createTime', 'createGmt', 'gmtCreate', 'time', 'timestamp']);
            let timeText = '';
            if (typeof timeRaw === 'number' && timeRaw > 0) {
                const ms = timeRaw > 1e12 ? timeRaw : timeRaw * 1000;
                timeText = new Date(ms).toLocaleString('zh-CN');
            } else if (timeRaw) {
                timeText = String(timeRaw);
            }
            const user = pick(c, ['nick', 'nickname', 'userName', 'name', 'senderName', 'uname']);
            const text = pick(c, ['content', 'text', 'message', 'commentContent', 'body']);
            if (!text && !user) continue;
            out.push({
                time: timeText,
                user: String(user || '匿名'),
                text: String(text || ''),
                raw: c,
            });
        }
        return out;
    }
    // .txt —— 逐条「[时间] 用户: 内容」
    function chatToTxt(list) {
        return list.map((m) => '[' + (m.time || '-') + '] ' + m.user + ': ' + m.text).join('\r\n') + '\r\n';
    }
    // .json —— 带元信息的完整结构（保留原始字段, 方便二次处理）
    function chatToJson(list, meta) {
        return JSON.stringify(Object.assign({
            exportedAt: new Date().toISOString(),
            count: list.length,
            messages: list.map((m) => ({ time: m.time, user: m.user, text: m.text })),
        }, meta || {}), null, 2);
    }
    // .csv —— 带 BOM, Excel 打开中文不乱码; 字段里的引号/换行按 RFC 4180 转义
    function chatToCsv(list) {
        const cell = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
        const rows = [cell('时间') + ',' + cell('用户') + ',' + cell('内容')];
        for (let i = 0; i < list.length; i++) rows.push(cell(list[i].time) + ',' + cell(list[i].user) + ',' + cell(list[i].text));
        return '\ufeff' + rows.join('\r\n') + '\r\n';
    }
    // .html —— 自带样式, 直接双击就能看/打印
    function chatToHtml(list, meta) {
        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const rows = list.map((m) => '<tr><td class="t">' + esc(m.time) + '</td><td class="u">' +
            esc(m.user) + '</td><td>' + esc(m.text) + '</td></tr>').join('');
        const title = esc((meta && meta.title) || '直播聊天记录');
        return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>' + title + '</title><style>' +
            'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
            'margin:24px;background:#fff;color:#1b1d21}' +
            'h1{font-size:17px;margin:0 0 4px}.meta{color:#6b7280;font-size:12px;margin-bottom:14px}' +
            'table{border-collapse:collapse;width:100%}' +
            'th,td{border-bottom:1px solid #e8eaed;padding:6px 8px;text-align:left;vertical-align:top}' +
            'th{background:#f5f6f7;font-weight:600}' +
            'td.t{white-space:nowrap;color:#6b7280;width:150px}td.u{white-space:nowrap;width:130px;font-weight:600}' +
            'tr:hover td{background:#fafbfc}' +
            '@media print{body{margin:0}th{background:#eee}}</style></head><body>' +
            '<h1>' + title + '</h1><div class="meta">共 ' + list.length + ' 条 · 导出于 ' +
            esc(new Date().toLocaleString('zh-CN')) + '</div>' +
            '<table><thead><tr><th>时间</th><th>用户</th><th>内容</th></tr></thead><tbody>' +
            rows + '</tbody></table></body></html>';
    }
    // 格式名 → {ext, mime, render}。UI 与保存共用这一张表, 不在两处各写一遍。
    function chatFormat(name, list, meta) {
        const table = {
            txt: { ext: 'txt', mime: 'text/plain;charset=utf-8', render: chatToTxt },
            json: { ext: 'json', mime: 'application/json;charset=utf-8', render: chatToJson },
            csv: { ext: 'csv', mime: 'text/csv;charset=utf-8', render: chatToCsv },
            html: { ext: 'html', mime: 'text/html;charset=utf-8', render: chatToHtml },
        };
        const f = table[name] || table.txt;
        return { ext: f.ext, mime: f.mime, text: f.render(list, meta || {}) };
    }


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
        #dlr-ring{position:fixed;pointer-events:none;z-index:1000000;overflow:visible;
            opacity:0;transition:opacity 400ms ease-out}
        #dlr-ring.on{opacity:1}
        #dlr-ring .ring-track{fill:none;stroke:rgba(61,110,255,.28);stroke-width:3}
        #dlr-ring .ring-beam{fill:none;stroke-width:3.5;stroke-linecap:round;
            filter:drop-shadow(0 0 5px rgba(61,110,255,.85));
            animation:dlrRingDash 3s linear infinite}
        /* 偏移量用 CSS 变量：JS 按真实周长写入 --ring-perim，
           动画整周期正好走完一圈，不会像写死 -400 那样在高周长面板上
           看起来「走得很快」或「几乎不动」。 */
        @keyframes dlrRingDash{from{stroke-dashoffset:0}to{stroke-dashoffset:calc(-1 * var(--ring-perim, 900px))}}
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
        /* v3.2.1: .bin 是真正的滚动区 —— 之前 overflow:hidden 把内容裁死
           (实测内容 530px / 可见 271px, 而 .body 的 scrollHeight==clientHeight 永不滚动),
           下载按钮被压到可见区下方 91px、更多设置 211px, 用户点不到 → 改 overflow-y:auto
           让滚轮直接生效. overflow-x 仍隐藏, 横向不许出滚动条. */
        #dlr-panel .bin{overflow-x:hidden;overflow-y:auto;min-height:0;min-width:0;scrollbar-width:thin}
        #dlr-panel .bin::-webkit-scrollbar{width:6px}
        #dlr-panel .bin::-webkit-scrollbar-thumb{background:#3a3f4b;border-radius:3px}
        #dlr-panel .bin::-webkit-scrollbar-track{background:transparent}
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
        /* 进度条高度由内容决定，不用固定 22px。
           原来 height:22px + overflow:hidden，而 .pct 是 height:100% 的居中单行：
           标签一长（切片数 · 体积 · 速度 · 剩余时间 · 已暂停）就折成两行，文字块 34px
           高于 22px 的框，下半行被裁掉（实测 clippedBy 14px，只剩上半行可见，
           看起来像「进度条变细了」）。
           现 min-height:22px 保住单行时的原样，height:auto 让它按内容长高；
           .bar / .stripes 用 inset:0 自动跟随新高度。 */
        #dlr-progress{position:relative;min-height:22px;height:auto;margin-top:10px;
            background:#0f1115;border:1px solid #23262e;
            border-radius:11px;overflow:hidden;display:none}
        #dlr-progress.on{display:block}
        #dlr-progress .bar{position:absolute;left:0;top:0;bottom:0;width:0%;background:#3d6eff;transition:width .25s ease}
        #dlr-progress .stripes{position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.16) 0 8px,transparent 8px 16px);background-size:32px 32px;animation:dlrSlide .6s linear infinite;pointer-events:none}
        /* 居中靠 padding + line-height，不用 height:100% + align-items：
           后者在多行时会把文字块按盒子高度居中，末行仍可能被裁。
           line-height:1.35 让两行时的行距不挤。 */
        #dlr-progress .pct{position:relative;display:flex;align-items:center;justify-content:center;
            padding:2px 8px;min-height:20px;box-sizing:border-box;
            font-size:12px;line-height:1.35;color:#fff;font-weight:600;
            text-align:center;white-space:normal;overflow-wrap:anywhere;
            text-shadow:0 1px 2px rgba(0,0,0,.5)}
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
        /* 面板内嵌侧栏 (v3.2.0, 实验性): 面板是页签条父容器的流内最后一个子块,
           几何全交给 CSS —— 不用 JS 追 (v3.0.9 教训). 页签固定在上方永不被遮挡,
           内容区 flex 自行让位且照常滚动; 收起(.mini)后只剩横条, 空间全部还给互动. */
        #dlr-panel.docked{position:relative!important;inset:auto!important;
            width:100%!important;padding:0 8px 8px!important;margin:0;z-index:5;
            max-height:none;transition:none}
        #dlr-panel.docked .drag{cursor:default}
        /* v3.3.1: 内容紧凑后给滚动区更多高度 —— 侧栏列高 632px, 页签条 50px,
           面板横条区约 56px, 所以 body 上限取 min(430px,62vh) 仍留余量 */
        #dlr-panel.docked .body{max-height:min(430px,62vh);width:100%}
        #dlr-panel.docked.mini{width:100%!important;padding:0 8px 8px!important}
        /* ---------- 内嵌态紧凑排版 (v3.3.1) ----------
           实测 (登录态, 更多设置全部展开): 内容 937px vs 侧栏可见 237px, 只能看到 1/4.
           逐块高度: 队列区 89 + 设置区 184 + 更多设置 437 + 按钮行 59 + 状态 49.
           紧凑化只作用于内嵌态 (.docked), 悬浮态外观与手感完全不变:
             行间距 3→1px, 区块间距 5→3px, 控件高与字号各收一档,
             状态栏/进度条/页脚缩小, 队列框 2 行→1 行.
           纯 CSS, 不动结构与逻辑. */
        #dlr-panel.docked .row{margin:1px 0;gap:4px}
        #dlr-panel.docked .sec{padding-top:3px;margin-top:3px}
        #dlr-panel.docked .tip{margin-top:1px;font-size:10px;line-height:1.3}
        #dlr-panel.docked h3{font-size:12px;margin-bottom:0}
        #dlr-panel.docked .sub{font-size:10px;margin-bottom:4px}
        #dlr-panel.docked .drag{padding-right:44px}
        #dlr-panel.docked input[type=text],#dlr-panel.docked input[type=number],
        #dlr-panel.docked select{padding:2px 5px;font-size:11px}
        #dlr-panel.docked textarea{padding:2px 5px;font-size:11px}
        #dlr-panel.docked #dlr-url{font-size:11px}
        #dlr-panel.docked button{padding:2px 6px;font-size:11px}
        #dlr-panel.docked button.primary{padding:5px 10px;font-size:12px;border-radius:6px}
        #dlr-panel.docked #dlr-status{margin-top:4px;padding:4px 6px;font-size:11px;
            min-height:22px;line-height:1.4}
        #dlr-panel.docked #dlr-progress{margin-top:5px;min-height:18px}
        #dlr-panel.docked #dlr-progress .pct{font-size:11px;min-height:16px;padding:1px 6px}
        #dlr-panel.docked .foot{margin-top:5px;padding-top:4px;font-size:10px}
        #dlr-panel.docked .grid2{gap:0 6px;margin-top:3px}
        #dlr-panel.docked .grid2>.chk{font-size:11px}
        #dlr-panel.docked .mrow{margin-top:2px;gap:6px}
        #dlr-panel.docked .more-body .mrow,#dlr-panel.docked .more-body .grid2{margin-top:2px}
        #dlr-panel.docked .more-toggle{font-size:11px;padding:1px 0}
        /* 队列框 (粘贴链接那个框) 的文字必须始终读得完 —— 它是固定高度输入框,
           不随面板被压小; min-height 让用户自己 resize:vertical 也拖不到更小,
           overflow-y:auto 让多行链接滚动显示而不是被静默裁掉。
           实测: 20px 高时 scrollHeight 48 > clientHeight 19 (文字被藏)。 */
        #dlr-panel.docked #dlr-queue{height:42px;min-height:42px;line-height:18px;
            padding:2px 5px;overflow-y:auto}
        /* aria2 区块实测占 172px (更多设置 373px 里最大的一块), 说明文字就吃掉 39px.
           内嵌态压到约 100px: 行更紧凑 + 说明限高两行. */
        #dlr-panel.docked #dlr-aria2-box{margin:3px 0;padding:3px 5px}
        #dlr-panel.docked #dlr-aria2-box .arow{margin:1px 0;gap:4px}
        #dlr-panel.docked #dlr-aria2-box .atip{font-size:9.5px;line-height:1.25;margin-top:1px;
            max-height:2.6em;overflow:hidden}
        #dlr-panel.docked #dlr-aria2-box button{margin-top:2px;padding:2px 6px}
        #dlr-panel.docked #dlr-aria2-state{font-size:10px;min-height:12px;margin-top:1px}
        #dlr-panel.docked label{min-width:56px;font-size:11px}
        /* ---------- 内嵌态可拉伸高度 (v3.4.0) ----------
           页签条下可用空间实测 581px (侧栏列 632 - 页签条 50), 面板默认 430px。
           底边把手拖动改高度, 由 --dlr-dock-h 表达; JS 只负责夹进 [下限, 可用空间]。
           收起态 (.mini) 完全绕开: .body 此时是 grid-template-rows:0fr + opacity:0,
           高度本就为 0, 所以收起时 height:auto、把手隐藏, 不留任何能顶开它的约束。

           「不能缩小到看不见文字」这条**只约束队列框自身**, 不是约束整个面板:
           面板变矮时 .bin 照常滚动, 而队列框是固定高度输入框, 它的文字必须始终可读
           —— 见下面 #dlr-queue 的 min-height。 */
        #dlr-panel.docked .body{height:var(--dlr-dock-h, 430px);max-height:none;min-height:0}
        /* .bin 只做滚动, 不加 min-height: min-height 加在滚动容器上既不能保证
           文字可见 (可见性由元素自身高度决定), 又会和 .body 的固定高度打架 ——
           收起态 0fr 被顶开后面板实测高达 629px、直接吃满整条侧栏。 */
        #dlr-panel.docked .bin{max-height:none}
        #dlr-panel.docked.mini .body{height:auto;max-height:none;min-height:0}
        #dlr-dock-resize{position:absolute;left:0;right:0;top:0;height:10px;
            cursor:ns-resize;z-index:6;touch-action:none;user-select:none;-webkit-user-select:none}
        #dlr-dock-resize::after{content:'';position:absolute;left:50%;top:3px;
            transform:translateX(-50%);width:34px;height:3px;border-radius:2px;
            background:#4a5160;transition:background 150ms ease}
        #dlr-dock-resize:hover::after{background:#3d6eff}
        #dlr-panel.docked.mini #dlr-dock-resize{display:none}
        /* 悬浮态高度随内容自适应, 把手无效: 隐藏, 顺带让出标题栏顶部的拖动区域 (v3.5.2) */
        #dlr-panel:not(.docked) #dlr-dock-resize{display:none}
        #dlr-panel.docked.mini .body{width:100%}
        /* aria2 区块 (v3.3.0, 实验性): 主机/端口/密钥/目录 + 状态行 + 测试按钮 */
        #dlr-aria2-box{margin:6px 0;padding:6px 8px;border:1px solid #23262e;border-radius:6px}
        #dlr-aria2-box .arow{display:flex;align-items:center;gap:5px;margin:3px 0;flex-wrap:wrap}
        #dlr-aria2-box .arow>label{flex:0 0 auto;min-width:44px}
        #dlr-aria2-box input{flex:1;min-width:0;box-sizing:border-box;padding:3px 6px;
            background:#0f1115;color:#e8eaee;border:1px solid #2c303a;border-radius:6px;
            outline:none;font-size:12px}
        #dlr-aria2-box input:focus{border-color:#3d6eff;box-shadow:0 0 0 2px rgba(61,110,255,.25)}
        #dlr-aria2-box .adir{flex:2 1 120px}
        #dlr-aria2-box #dlr-aria2-host{flex:1 1 84px}
        #dlr-aria2-box #dlr-aria2-port{flex:0 1 66px}
        #dlr-aria2-box .atip{font-size:10.5px;line-height:1.35;color:#6d727c;margin-top:3px}
        #dlr-aria2-box button{width:100%;margin-top:3px}
        #dlr-aria2-state{font-size:11px;color:#7d828d;min-height:15px;line-height:1.35;margin-top:3px}
        #dlr-aria2-state.ok{color:#7fc98a}
        #dlr-aria2-state.bad{color:#ff7a7a}
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
        /* 底栏钉在 .body 后 (移出 .bin), 收起态必须整体隐藏, 否则 0fr 之上留 24px 幽灵条 */
        #dlr-panel.mini .foot{display:none}
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
        <div id="dlr-dock-resize" title="拖动调整面板高度 (有下限, 不会把文字压没)"></div>
        <div class="drag">
        <h3>钉钉直播回放下载</h3>
        <div class="sub">免登录, 公开接口抓取 m3u8</div>
        </div>
        <div class="sec"><div class="row"><input type="text" id="dlr-url" placeholder="粘贴回放链接, 或自动读取本页"></div>
            <div class="row" style="margin-top:6px">
                <textarea id="dlr-queue" rows="1" style="flex:1;resize:vertical;font:inherit;font-size:12px;
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
            <button id="dlr-chat" title="导出本场回放的聊天记录 (实验性). 需要登录态; 可选 .txt / .json / .csv / .html 四种格式">💬 导出聊天记录</button>
            <select id="dlr-chat-fmt" title="聊天记录导出格式"><option value="txt" selected>.txt</option><option value="json">.json</option><option value="csv">.csv</option><option value="html">.html</option></select>
        </div>
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
                    <label class="chk" title="实验性, 默认关闭. 打开后整个面板立刻内嵌到右侧 互动/简介 侧栏的页签下方(页面一加载就嵌, 不是等解析完才嵌), 页签与互动内容都在下方照常可用、不被遮挡; 收起面板即可把空间还给互动. 页面上找不到侧栏时(如未登录)自动保持悬浮.">
                        <input type="checkbox" id="dlr-dock">面板内嵌侧栏(实验性)</label>
                    <label class="chk" title="实验性, 默认关闭. 开启后**所有下载任务**改由本机 aria2 执行: 点「下载本页回放」以及队列里的每一个回放, 切片逐条 addUri, 面板内的切片下载/拼接/保存全部跳过. 关闭时行为与之前完全一致. 需要本机已启动 aria2 RPC (默认 127.0.0.1:6801, 强烈建议配 --rpc-secret).">
                        <input type="checkbox" id="dlr-aria2-on">下载交给 aria2(实验性)</label>
                </div>
                <div id="dlr-aria2-box" style="display:none">
                    <div class="arow">
                        <input type="text" id="dlr-aria2-host" title="aria2 RPC 主机, 建议保持 127.0.0.1">
                        <input type="number" id="dlr-aria2-port" min="1" max="65535" title="aria2 RPC 端口 (默认 6801)">
                    </div>
                    <div class="arow">
                        <input type="password" id="dlr-aria2-secret" placeholder="aria2 密钥 (对应 --rpc-secret)" title="aria2 --rpc-secret 的值; 留空表示未启用密钥">
                        <input type="text" id="dlr-aria2-dir" class="adir" placeholder="保存目录 (留空 = aria2 默认)" title="aria2 的保存目录; 留空则用 aria2 自己配置的 dir">
                    </div>
                    <div class="arow">
                        <button id="dlr-aria2-test" title="调用 aria2.getVersion 探测本机 aria2 是否可达、密钥是否正确">🔌 测试连接</button>
                    </div>
                    <div id="dlr-aria2-state"></div>
                    <div class="atip">实验性. aria2 不支持 m3u8, 逐条把切片 URL 交给它下载; 合成单文件用 ffmpeg -f concat.</div>
                </div>
                <div class="tip">预取播放地址与切片索引, 打开页面后无需等待即可直接下载.</div>
            </div></div>
        </div>
        </div>
        <div class="foot">
            <span>v<span id="dlr-ver">--</span></span>
            <span id="dlr-update" title="检查更新; 发现新版后点击跳转下载页">检查更新</span>
            <span style="color:#3a3f4b">|</span>
            <span>By</span>
            <a href="https://github.com/Vectg" target="_blank" rel="noopener noreferrer">@Vectg</a>
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

    // ---------- aria2 推送 (v3.3.0, 实验性) ----------
    // 前三个是纯函数 (无 IO), 可直接单测; 真正发 RPC 的 aria2Call 只做一次 POST。

    // 切片落盘名: 用序号补零到 5 位, 保证 aria2 下载完能按顺序 concat。
    // sequence 缺失时退回下标 +1 —— 两者都是整数, 不能出现 seg2.ts 排在 seg10.ts 前面。
    function aria2SegName(seg, index) {
        const raw = (seg && seg.sequence !== undefined && seg.sequence !== null && isFinite(seg.sequence))
            ? seg.sequence : (index + 1);
        return 'seg' + String(Math.max(0, Math.round(raw))).padStart(5, '0') + '.ts';
    }
    // 单个 addUri 的 options。header 必须是字符串数组 (aria2 原样附加到 HTTP 请求头),
    // 实测 Referer / User-Agent / Cookie 都能透传; 钉钉切片不需要 Cookie。
    function aria2Options(out, dir, headers, extra) {
        const o = {};
        if (out) o.out = out;
        if (dir) o.dir = dir;
        if (headers && headers.length) o.header = headers.slice();
        if (extra) { for (const k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k]; } }
        return o;
    }
    // 组装一批 addUri 的请求体。分片太多时一次请求塞不下 (实测几百条尚可, 上千条要分批),
    // 所以按 caller 传入的批大小切分 —— 这里只负责把一批拼成 JSON-RPC 结构。
    function aria2BuildBatch(gids, items, secret) {
        const calls = items.map((it) => {
            const params = [];
            if (secret) params.push('token:' + secret);
            params.push([it.url]);
            params.push(it.options);
            return { methodName: 'aria2.addUri', params };
        });
        return { jsonrpc: '2.0', id: 'dlr-' + (gids || ''), method: 'system.multicall', params: [calls] };
    }
    // RPC 错误 → 人话。aria2 的错误码实测只有 1(Unauthorized) 等少数几个,
    // 更多情况要靠 message 文本判断, 所以两条路都给。
    function aria2Explain(msg) {
        const m = String(msg || '');
        if (/Unauthorized/i.test(m)) return '密钥不对 (aria2 报 Unauthorized) — 请核对 --rpc-secret';
        if (/Invalid Request/i.test(m)) return 'aria2 版本不兼容该请求 (Invalid Request)';
        if (/No such method/i.test(m)) return '这个 aria2 没有该方法 (No such method), 版本可能太老';
        if (/ECONNREFUSED|连接|reach|Failed to fetch/i.test(m)) return '连不上 aria2 — 确认它已启动且 RPC 端口/主机填对';
        return m;
    }
    // ---------- aria2 RPC 传输层 (v3.3.0, 实验性) ----------
    // 只发 POST 到 /jsonrpc (实测 GET 一律 Invalid Request)。gmx 会把非 2xx 当失败抛错,
    // 这里不用它 —— RPC 的错误在 200 的 JSON body 里 (error.code/message), 走 gmx 会丢上下文。
    function aria2Rpc(cfg, payload, timeout) {
        const url = 'http://' + cfg.host + ':' + cfg.port + '/jsonrpc';
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: timeout || 15000,
                onload: (r) => {
                    let body = null;
                    try { body = JSON.parse(r.response); } catch (e) { }
                    if (!body) {
                        reject(new Error('aria2 返回的不是 JSON (HTTP ' + r.status + '): ' +
                            String(r.response || '').slice(0, 120)));
                        return;
                    }
                    // system.multicall 的错误在 result[] 里逐条; 单条调用在顶层 error
                    if (body.error) {
                        reject(new Error(aria2Explain(body.error.message || ('code ' + body.error.code))));
                        return;
                    }
                    resolve(body);
                },
                onerror: (e) => reject(new Error(aria2Explain('网络错误 ' + (e && e.error ? e.error : '')))),
                ontimeout: () => reject(new Error('aria2 请求超时')),
                onabort: () => reject(new Error('aria2 请求被中断')),
            });
        });
    }
    // 一次 POST 最多塞多少条切片: 单条 addUri 请求体约 300 字节, 留足余量。
    const ARIA2_BATCH = 40;
    // 把解析出的切片列表切成一批批 addUri 参数。切片顺序即 m3u8 顺序, 不能重排。
    function aria2Plan(segments, dir, referer, ua) {
        const headers = [];
        if (referer) headers.push('Referer: ' + referer);
        if (ua) headers.push('User-Agent: ' + ua);
        const items = [];
        for (let i = 0; i < segments.length; i++) {
            const s = segments[i];
            if (!s || !s.url) continue;
            items.push({
                url: s.url,
                out: aria2SegName(s, i),
                options: aria2Options(aria2SegName(s, i), dir, headers),
            });
        }
        const batches = [];
        for (let i = 0; i < items.length; i += ARIA2_BATCH) batches.push(items.slice(i, i + ARIA2_BATCH));
        return { items: items, batches: batches };
    }

    // aria2 配置的**唯一读取入口**, 必须在模块级: init() 里的 arConfig 是局部 const,
    // run() 看不到它 —— 早先一版在 run() 里判 `typeof arConfig === 'function'` 永远为假,
    // 于是开启总开关后每次下载都报「aria2 配置尚未初始化」(浏览器验收抓出的真 bug)。
    function aria2Config() {
        const g = (id) => { try { return document.getElementById(id); } catch (e) { return null; } };
        const host = g('dlr-aria2-host'), port = g('dlr-aria2-port');
        const secret = g('dlr-aria2-secret'), dir = g('dlr-aria2-dir');
        return {
            host: (host && host.value.trim()) || ARIA2_HOST_DEF,
            port: (port && parseInt(port.value, 10)) || ARIA2_PORT_DEF,
            secret: (secret && secret.value) || '',
            dir: (dir && dir.value.trim()) || '',
        };
    }
    // 总开关状态也放模块级, run() 与面板 UI 共用同一个标志。
    window.__aria2Enabled = false;
    try { window.__aria2Enabled = !!GM_getValue('dlr_aria2_on', false); } catch (e) { }


    // 把一批切片推给 aria2 并汇报结果。返回 {ok, total, failed, firstErr}。
    // 「发送到 aria2」按钮与「下载交给 aria2」总开关共用这一条路径, 不复制逻辑。
    // opts: {segments, encrypted, fmp4, dir, referer, ua, secret, label}
    // 返回 {skipped:true, reason} 表示这条路 aria2 根本做不了 (加密/fMP4/空列表)。
    async function aria2PushAll(opts) {
        const segs = opts.segments || [];
        if (!segs.length) return { skipped: true, reason: '切片列表为空' };
        if (opts.encrypted) return { skipped: true, reason: 'AES-128 加密切片 (密钥只在浏览器里)' };
        if (opts.fmp4) return { skipped: true, reason: 'fMP4 回放 (含独立初始化段)' };
        const plan = aria2Plan(segs, opts.dir, opts.referer, opts.ua);
        if (!plan.items.length) return { skipped: true, reason: '没有可推送的切片 URL' };
        let gids = 0, failed = 0, firstErr = '';
        for (let b = 0; b < plan.batches.length; b++) {
            const payload = aria2BuildBatch(String(b + 1), plan.batches[b], opts.secret);
            const body = await aria2Rpc(opts.cfg, payload, 30000);
            const res = (body.result || []);
            for (let k = 0; k < res.length; k++) {
                if (res[k] && res[k].error) {
                    failed++;
                    if (!firstErr) firstErr = aria2Explain(res[k].error.message || ('code ' + res[k].error.code));
                } else gids++;
            }
        }
        return { ok: gids > 0, total: plan.items.length, gids: gids, failed: failed,
                 firstErr: firstErr, batches: plan.batches.length,
                 firstName: plan.items[0].out, lastName: plan.items[plan.items.length - 1].out };
    }


    // ---------- 面板内嵌侧栏的挂载宿主 (v3.2.0, 实验性) ----------
    // 结构 (登录态实测 2026-10-05): #live-room 是稳定 id, 两个子列 = 播放器列 + 侧栏列
    // (320x632, position:relative); 侧栏列内部是 flex 纵列 [绝对定位覆盖层,
    // 页签条 319x50, 内容区 flex:1 1 0%]. 侧栏列没有稳定 id, 全是 CSS-module 哈希
    // class, 所以只按 结构 + 几何 + 页签文本 定位, 绝不猜 class (每次发版都会变).
    //
    // 返回「页签条的父容器」: 面板 append 成它最后一个流内子块 → 页签固定在上、永不
    // 被遮挡, 内容区按 flex 自行让位且照常滚动 —— 用户硬要求: 内嵌不许影响互动/简介.
    // 找不到侧栏 (未登录页不挂载) → null, 调用方保持悬浮.
    function dockMount(doc) {
        const d = doc || document;
        const lr = d.getElementById('live-room');
        if (!lr || !lr.children) return null;
        const player = d.getElementById('ding_live_player') || d.getElementById('J_player');
        let col = null;
        for (let i = 0; i < lr.children.length; i++) {
            const c = lr.children[i];
            if (player && c.contains && c.contains(player)) continue;   // 播放器列跳过
            if (c.textContent && /互动|简介/.test(c.textContent)) { col = c; break; }
        }
        if (!col || !col.children || !col.children.length || !col.getBoundingClientRect) return null;
        let cr = null;
        try { cr = col.getBoundingClientRect(); } catch (e) { }
        if (!cr || cr.width <= 0 || cr.height <= 0) return null;
        const posOf = (el) => {
            try {
                if (typeof getComputedStyle === 'function') {
                    const p = getComputedStyle(el).position;
                    if (p) return p;
                }
            } catch (e) { }
            return (el.style && el.style.position) || '';
        };
        const inCol = (r) => r && r.width > 0 && r.height > 0 &&
            r.left >= cr.left - 2 && r.top >= cr.top - 2 &&
            r.left + r.width <= cr.left + cr.width + 2 &&
            r.top + r.height <= cr.top + cr.height + 2;
        // 前序找「页签条」: 高 ≤64px(实测 50)、在列内、非 absolute/fixed、文本含互动/简介.
        // 绝对定位覆盖层整棵剪掉 (里面也可能有小块提到「互动」但不是页签).
        let budget = 2000;
        const visit = (node) => {
            const kids = node.children;
            for (let i = 0; i < kids.length; i++) {
                if (budget-- <= 0) return null;
                const c = kids[i];
                if (!c || !c.getBoundingClientRect) continue;
                const pos = posOf(c);
                if (pos === 'absolute' || pos === 'fixed') continue;   // 剪掉覆盖层子树
                let r = null;
                try { r = c.getBoundingClientRect(); } catch (e) { }
                if (!r) continue;
                if (r.height > 0 && r.height <= 64 && inCol(r) &&
                    /互动|简介/.test(c.textContent || '')) return c;
                const deeper = visit(c);
                if (deeper) return deeper;
            }
            return null;
        };
        const bar = visit(col);
        return bar ? (bar.parentElement || col) : null;
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
        p.querySelector('.pct').textContent = label ? (label + ' ' + v + '%') : (v + '%');
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

            // v3.4.0: 「下载交给 aria2」总开关开启时, 这一整个下载改由本机 aria2 执行 ——
            // 浏览器内不再拉切片/拼接/保存, 面板只负责解析并推送任务清单。
            if (window.__aria2Enabled) {
                const arCfg = aria2Config();   // 模块级读取器
                progressSet(P.prep, '交给 aria2');
                const r = await aria2PushAll({
                    segments: parsed.segments, encrypted: parsed.encrypted, fmp4: parsed.fmp4,
                    dir: arCfg.dir, referer: REFERER, ua: navigator.userAgent || '',
                    secret: arCfg.secret, cfg: arCfg,
                });
                if (r.skipped) {
                    setStatus('⚠ 无法交给 aria2: ' + r.reason, true);
                    appendLog('⚠ 已跳过浏览器内下载: ' + r.reason);
                    progressDone(false);
                    diagRun(false, 'aria2 skipped: ' + r.reason, parsed.segments);
                    return;
                }
                const dirNote = arCfg.dir ? (' → ' + arCfg.dir) : ' (aria2 默认目录)';
                setStatus('✅ 已推给 aria2: ' + r.gids + '/' + r.total + ' 个切片' + dirNote +
                    (r.failed ? (' · ' + r.failed + ' 条失败: ' + r.firstErr) : ''), r.failed > 0);
                appendLog('⬇ aria2 已接管本次下载: ' + r.gids + '/' + r.total + ' 个切片 (' + r.batches + ' 批)' + dirNote);
                if (r.gids) {
                    appendLog('   文件名形如 ' + r.firstName + ' ... ' + r.lastName +
                        '; 合成单个文件: ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4');
                }
                progressDone(r.failed === 0);
                diagRun(r.failed === 0, 'aria2 ' + r.gids + '/' + r.total, parsed.segments);
                lastRunResult = { ok: r.failed === 0, name: '' };
                return;
            }
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

        ring.appendChild(ringGrad);
        ring.appendChild(ringTrack);
        ring.appendChild(ringBeam);
        document.body.appendChild(ring);
        // 光环跟随面板的位置和尺寸（含圆角）——SVG rect 几何
        // 光环必须贴着**看得见的那块面板**，也就是 .body，而不是 #dlr-panel。
        //
        // 根因（v3.0.2~3.0.7 三次改错的地方）：#dlr-panel 只是外壳，它有
        // `padding:14px 16px` 且 `background:transparent` —— 自身不可见；用户看到的
        // 深色圆角面板是它内部的 .body。之前光环一直按 #dlr-panel 的盒子画，于是它永远
        // 比可见面板大出一圈内边距（实测左右各 16px、上下各 14px），
        // 看起来就是「在外面框出一大块地方」。这不是同步/时序问题，改多少次
        // ResizeObserver、rAF、CSS 定位都不对 —— 参照对象本身就选错了。
        //
        // 例外：收缩成横条时 .body 被压成 0 高（grid-template-rows:0fr），
        // 那时可见的是 .expand 横条，要改用它。
        const ringTarget = () => {
            const b = panel.querySelector('.body');
            if (b && b.getBoundingClientRect().height > 1) return b;
            const ex = panel.querySelector('.expand');
            if (ex && ex.getBoundingClientRect().height > 1) return ex;
            return panel;
        };
        const syncRing = () => {
            const r = ringTarget().getBoundingClientRect();
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
            // dasharray 必须按**真实周长**设置。
            // 原来写死 pathLength=400 + dasharray 110 290：pathLength 会把实际周长
            // （几百 px）强行归一化成 400，dasharray 的比例随之失真，光带缩成一小段
            // 而不是沿整圈流动——这正是「光环看不见 / 只有一小截」的根因。
            const cw = Math.max(0, W - 4), ch = Math.max(0, H - 4);
            const perim = 2 * (cw + ch) - 8 * rx + 2 * Math.PI * rx;   // 圆角矩形周长
            if (perim > 0) {
                const seg = Math.max(24, perim * 0.28);   //亮段约占周长 28%
                // dasharray 必须用**逗号**分隔两个数。原来写成 seg + '' + (perim - seg)
                // 是字符串拼接：'533.1' + '1370.8' → '533.11370.8'，浏览器只解析出
                // 单个数 533.113（第二个小数点处截断），于是实际是「533px 实线 + 0.8px 缝」，
                // 绕一圈几乎全亮、根本看不出光带在流动。
                ringBeam.setAttribute('stroke-dasharray', seg + ',' + (perim - seg));
                ringBeam.style.strokeDashoffset = '0';
                ringBeam.style.setProperty('--ring-perim', perim + 'px');
            }
        };
        syncRing();
        // 光环显隐：用 .on 类切换（SVG 无 border，改由 CSS opacity 控制）
        // 显隐用内联 opacity，不用 class。实测本页面上 `.on{opacity:1}`
        // 虽已匹配却仍算出 0（与 .more-body 同一个坑），class 规则不可靠；
        // 内联优先级最高，不依赖任何样式表计算。
        const ringHide = () => { ring.classList.remove('on'); ring.style.opacity = '0'; };
        const ringShow = () => { ring.classList.add('on'); ring.style.opacity = '1'; syncRing(); };
        ringHide();
        // 面板几何变化时自动跟随光环。
        //
        // 原来靠 transitionstart/transitionend 启动/停止一个 rAF 逐帧循环，有三个致命缺陷：
        //  1) transitionstart 在**子元素**上也会冒泡到面板，收起面板时子元素先结束过渡
        //     （如 .collapse 的 opacity 150ms，比面板 280ms 短），ringAnimStop 立刻停掉循环，
        //     面板自己的高度/宽度过渡还在跑 —— 光环从此停在旧尺寸上不动了。
        //     表现就是「光环在外面框出一大块地方」/「展开后光环不跟着变大」。
        //  2) 面板尺寸变化的**原因**不只有过渡：更多设置展开（子元素 height 过渡）、
        //     状态栏换行、窗口缩放、字体加载，都不一定在面板上触发 transition，
        //     光环就完全失联。
        //  3) 只靠事件时机补一次 syncRing，补在动画中段（错位 20~187px）。
        //
        // 改为 ResizeObserver：面板盒子一变就同步，与「为什么变」无关，
        // 收起/展开/更多设置/窗口缩放全部覆盖。ResizeObserver 不冒泡，
        // 观察 #dlr-panel 自己即可拿到所有尺寸变化。
        let ringRaf = 0;
        const ringAnimLoop = () => {
            syncRing();
            ringRaf = requestAnimationFrame(ringAnimLoop);
            };
        // 过渡期间补 rAF，让 dasharray/圆角跟得上补间；非过渡期不常驻轮询。
        // 起停仍看面板自身的过渡，但**忽略子元素冒泡来的事件**，
        // 否则短过渡的子元素会提前把循环停掉（就是原来那个 bug）。
        const panelIsTransitioning = (e) => (e.target === panel);
        const ringAnimStart = (e) => {
            if (!panelIsTransitioning(e)) return;
            if (!ringRaf && ring.classList.contains('on')) ringAnimLoop();
        };
        const ringAnimStop = (e) => {
            if (!panelIsTransitioning(e)) return;
            if (ringRaf) { cancelAnimationFrame(ringRaf); ringRaf = 0; }
            syncRing();   // 兜底：补上最后一帧，避免停在动画中段的尺寸上
        };
        panel.addEventListener('transitionstart', ringAnimStart);
        panel.addEventListener('transitionend', ringAnimStop);
        // 窗口缩放会改变面板的位置（fixed 定位跟着视口走），尺寸没变时
        // ResizeObserver 不触发，同样要手动补一次。
        window.addEventListener('resize', () => {
            try { syncRing(); } catch (e) { }
        });
        // ResizeObserver 兜住所有「不触发面板自身 transition」的尺寸变化。
        // 它在过渡进行中也会连续触发，与 rAF 循环互补；两者同时存在也无害
        // （syncRing 幂等，只是重复写同样的一组属性）。
        if (typeof ResizeObserver === 'function') {
            try {
                const ro = new ResizeObserver(() => {
                    if (ring.classList.contains('on')) syncRing();
                });
                ro.observe(panel);
                window.__ringRO = ro;
            } catch (e) { /* 老浏览器无 ResizeObserver，靠事件路径也能工作 */ }
        }
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
        // 收起/展开时重算内嵌高度下限 (收起态必须清零, 见 CSS 注释)。
        try { if (window.__dockSyncHeight) window.__dockSyncHeight(); } catch (e) { }
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

        // ---------- aria2 推送 (v3.3.0, 实验性) ----------
        // 设置项持久化; 密钥只写 GM 存储, 不外发、不进诊断日志。
        const arHost = $('dlr-aria2-host'), arPort = $('dlr-aria2-port'),
            arSecret = $('dlr-aria2-secret'), arDir = $('dlr-aria2-dir'),
            arState = $('dlr-aria2-state'), arTest = $('dlr-aria2-test');
        const arSetState = (txt, cls) => {
            if (!arState) return;
            arState.textContent = txt || '';
            arState.className = cls || '';
        };
        // aria2 总开关 (v3.4.0, 实验性, 默认关闭): 开启后**所有**下载任务交给 aria2,
        // 包括「下载本页回放」与队列里的每个回放; 关闭时行为与之前完全一致。
        window.__aria2Enabled = false;
        try { window.__aria2Enabled = !!GM_getValue('dlr_aria2_on', false); } catch (e) { }
        const arOnChk = $('dlr-aria2-on');
        // 配置区只在勾选总开关后才展示: 未启用 aria2 时不该占着面板空间。
        const arBox = $('dlr-aria2-box');
        const arSyncBox = () => {
            if (arBox) arBox.style.display = (window.__aria2Enabled ? '' : 'none');
        };
        arSyncBox();
        if (arOnChk) {
            arOnChk.checked = window.__aria2Enabled;
            arOnChk.addEventListener('change', () => {
                window.__aria2Enabled = arOnChk.checked;
                try { GM_setValue('dlr_aria2_on', arOnChk.checked); } catch (e) { }
                arSetState(arOnChk.checked ? '已开启: 之后的所有下载都交给 aria2' : '');
                arSyncBox();
                appendLog(arOnChk.checked
                    ? '⬇ 已开启「下载交给 aria2」, 之后所有下载任务改由本机 aria2 执行'
                    : '⬇ 已关闭「下载交给 aria2」, 下载回到浏览器内');
            });
        }

        // 面板读配置统一走模块级读取器, 不留两份实现。
        const arConfig = () => aria2Config();
        const arSave = () => {
            try {
                GM_setValue('dlr_aria2_host', arConfig().host);
                GM_setValue('dlr_aria2_port', arConfig().port);
                GM_setValue('dlr_aria2_secret', arConfig().secret);
                GM_setValue('dlr_aria2_dir', arConfig().dir);
            } catch (e) { }
        };
        // 回填已存设置 (密钥回填是本地存储→本地输入框, 不经过网络)。
        if (arHost) {
            try { arHost.value = GM_getValue('dlr_aria2_host', ARIA2_HOST_DEF) || ARIA2_HOST_DEF; } catch (e) { }
            try { arPort.value = GM_getValue('dlr_aria2_port', ARIA2_PORT_DEF) || ARIA2_PORT_DEF; } catch (e) { }
            try { arSecret.value = GM_getValue('dlr_aria2_secret', '') || ''; } catch (e) { }
            try { arDir.value = GM_getValue('dlr_aria2_dir', '') || ''; } catch (e) { }
            [arHost, arPort, arSecret, arDir].forEach((el) => {
                el && el.addEventListener('change', () => { arSave(); arSetState(''); });
            });
        }
        // 测试连接: getVersion 是最轻的调用, 拿它区分「连不上 / 密钥错 / 版本不兼容」。
        arTest && arTest.addEventListener('click', async () => {
            const cfg = arConfig();
            arSave();
            arTest.disabled = true;
            arSetState('正在连接 ' + cfg.host + ':' + cfg.port + ' ...');
            try {
                const params = [];
                if (cfg.secret) params.push('token:' + cfg.secret);
                params.push([]);
                const body = await aria2Rpc(cfg, { jsonrpc: '2.0', id: 'dlr-test', method: 'aria2.getVersion', params: params }, 8000);
                const ver = (body.result && body.result.version) || '未知';
                const enabled = (body.result && body.result.enabledFeatures) || [];
                // 数字型字段一律是字符串 (aria2 实测), 所以 split 出现就是支持
                arSetState('✅ 已连接 aria2 ' + ver +
                    (enabled.indexOf('RPC') >= 0 ? '' : ' (未启用 RPC?)'), 'ok');
                appendLog('🔌 aria2 连接成功, 版本 ' + ver);
            } catch (e) {
                arSetState('❌ ' + e.message, 'bad');
                appendLog('🔌 aria2 连接失败: ' + e.message);
            } finally {
                arTest.disabled = false;
            }
        });

        // ---------- 聊天记录导出 (v3.5.0, 实验性) ----------
        const chatBtn = $('dlr-chat'), chatFmt = $('dlr-chat-fmt');
        chatBtn && chatBtn.addEventListener('click', async () => {
            let p = null;
            try { p = parseUrl(($('dlr-url') && $('dlr-url').value) || location.href); }
            catch (e) {
                setStatus('⚠ 请先填入或打开一个回放页面', true);
                return;
            }
            const fmtName = (chatFmt && chatFmt.value) || 'txt';
            const oldText = chatBtn.textContent;
            chatBtn.disabled = true;
            chatBtn.textContent = '⏳ 拉取中...';
            try {
                const list = await fetchAllChat(p.roomId, p.liveUuid, 20);
                if (!list.length) {
                    setStatus('⚠ 这个回放没有可导出的聊天记录', true);
                    appendLog('💬 聊天记录: 0 条');
                    return;
                }
                const title = (prepCache && prepCache.model && prepCache.model.title) || '直播回放';
                const out = chatFormat(fmtName, list, { title: title, roomId: p.roomId, liveUuid: p.liveUuid });
                const base = (sanitize(title) || 'chat') + '-聊天记录.' + out.ext;
                const blob = new Blob([out.text], { type: out.mime });
                await downloadBlob(blob, base);
                setStatus('💬 已导出 ' + list.length + ' 条聊天记录: ' + base);
                appendLog('💬 已导出 ' + list.length + ' 条 (' + out.ext + '): ' + base);
            } catch (e) {
                setStatus('❌ 聊天记录导出失败: ' + e.message, true);
                appendLog('❌ 聊天记录导出失败: ' + e.message);
            } finally {
                chatBtn.disabled = false;
                chatBtn.textContent = oldText;
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
            if (panel.classList.contains('docked')) return;   // 内嵌态几何归 CSS, 拖拽/resize 不写位置
            const r = panel.getBoundingClientRect();
            const p = posToRightBottom(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
            panel.style.left = p.left;
            panel.style.top = p.top;
            // v3.2.1: right/bottom 写 'auto' 而不是像素值 —— top+bottom 同时存在会把
            // shell 高度钉成上下间距（悬浮收起态实测 570px 空壳）。只锚定 left/top，
            // 高度交还给内容；inline 'auto' 同时压过样式表默认的 right:16/bottom:16。
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            // 记下**钳制后**的坐标：下一轮 resize 要以它为基准，否则误差会逐次累积
            lastPos = { x: parseFloat(p.left) || 0, y: parseFloat(p.top) || 0 };
            // 拖动只改位置不改尺寸，ResizeObserver 不会触发，光环必须手动跟上。
            // 漏掉这一步的表现：拖动面板时光环停在原地不动，面板滑走了，
            // 光环独自框在旧位置一大块地方（暂停状态下拖动尤其明显）。
            try { syncRing(); } catch (e) { }
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

        // ---------- 面板内嵌侧栏 (v3.2.0, 实验性) ----------
        // 几何全部由 CSS 拥有: 内嵌态在 applyPos / mousedown 两处已挡,
        // 光环照旧按 .body 实测跟随 (ringTarget 不用改, 3.0.9 的参照对象不变).
        let dockHost = null;
        const docked = () => panel.classList.contains('docked');
        function dockPanel() {
            const host = dockMount(document);
            if (!host) return false;
            panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
            panel.classList.add('docked');
            host.appendChild(panel);
            dockHost = host;            // 入槽后重算高度: 上限依赖本页的页签条位置。
            try { if (window.__dockSyncHeight) window.__dockSyncHeight(); } catch (e) { }
            try { syncRing(); } catch (e) { }
            return true;
        }
        function undockPanel() {
            if (!docked()) return;
            panel.classList.remove('docked');
            dockHost = null;
            document.body.appendChild(panel);
            // 回悬浮: 清掉内嵌高度变量, 悬浮态用 CSS 默认高度。
            panel.style.removeProperty('--dlr-dock-h');
            panel.style.removeProperty('--dlr-dock-min');
            try { restorePos(); } catch (e) { }   // 回到悬浮: 拖过的坐标 / 没拖过就是右下角
            try { syncRing(); } catch (e) { }
        }
        // ---------- 内嵌态高度可拉伸 (v3.4.0) ----------
        // 纯几何: 下限按实测「文字不被裁」算, 上限按页签条以下的实际空间算。
        const DOCK_MIN_H = 330;
        // 页签条以下到列底 = 可用高度; 找不到页签条就退回 430。
        function dockSpace() {
            const host = dockHost;
            if (!host || !host.getBoundingClientRect) return 430;
            const colR = host.getBoundingClientRect();
            for (let i = 0; i < host.children.length; i++) {
                const c = host.children[i];
                if (c === panel) continue;
                let r = null, pos = '';
                try { r = c.getBoundingClientRect(); pos = getComputedStyle(c).position; } catch (e) { }
                if (!r || r.height <= 0 || r.height > 64) continue;
                if (pos === 'absolute' || pos === 'fixed') continue;
                if (/互动|简介/.test(c.textContent || '')) {
                    return Math.max(DOCK_MIN_H, Math.floor(colR.bottom - r.bottom) - 8);
                }
            }
            return 430;
        }
        // 唯一的写入口: 拖动、窗口缩放、dock/undock、收起/展开都走它。
        function applyDockHeight(px) {
            if (!docked()) return;
            const h = Math.max(DOCK_MIN_H, Math.min(dockSpace(), Math.round(px)));
            panel.style.setProperty('--dlr-dock-h', h + 'px');
            // 收起态清零下限, 否则 .bin 的 min-height 会顶开 .body 的 0fr。
            try { syncRing(); } catch (e) { }
            return h;
        }
        // 供 applyMini / dockPanel / undockPanel 复用。
        window.__dockSyncHeight = () => {
            if (!docked()) return;
            let h = parseInt(panel.style.getPropertyValue('--dlr-dock-h'), 10);
            if (!(isFinite(h) && h > 0)) { try { h = parseInt(GM_getValue('dlr_dock_h'), 10); } catch (e) { h = NaN; } }
            applyDockHeight(isFinite(h) && h > 0 ? h : 430);
        };
        try {
            const savedH = parseInt(GM_getValue('dlr_dock_h'), 10);
            if (isFinite(savedH) && savedH >= DOCK_MIN_H) applyDockHeight(savedH);
        } catch (e) { }
        // 拖动把手改高度 (v3.5.2 起把手位于面板顶边; 底边跟随指针, 下拖 = 变高); pointer 事件同时覆盖鼠标/触屏, setPointerCapture 保证
        // 指针拖出把手范围也不丢事件。
        const rz = $('dlr-dock-resize');
        if (rz) {
            let rStart = 0, hStart = 0, rActive = false;
            rz.addEventListener('pointerdown', (e) => {
                if (!docked() || panel.classList.contains('mini')) return;
                rStart = e.clientY;
                hStart = panel.getBoundingClientRect().height;
                rActive = true;
                try { rz.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault(); e.stopPropagation();
            });
            rz.addEventListener('pointermove', (e) => {
                if (!rActive) return;
                e.preventDefault();
                applyDockHeight(hStart + (e.clientY - rStart));   // 往下拖 = 变高
            });
            const rzEnd = (e) => {
                if (!rActive) return;
                rActive = false;
                try { rz.releasePointerCapture(e.pointerId); } catch (err) { }
                try { GM_setValue('dlr_dock_h', applyDockHeight(panel.getBoundingClientRect().height)); } catch (err) { }
                try { syncRing(); } catch (err) { }
            };
            rz.addEventListener('pointerup', rzEnd);
            rz.addEventListener('pointercancel', rzEnd);
            window.addEventListener('resize', () => { if (docked()) applyDockHeight(panel.getBoundingClientRect().height); });
        }

        const dockChk = $('dlr-dock');
        if (dockChk) {
            let want = false;
            try { want = !!GM_getValue('dlr_dock', false); } catch (e) { }
            dockChk.checked = want;
            dockChk.addEventListener('change', () => {
                try { GM_setValue('dlr_dock', dockChk.checked); } catch (e) { }
                if (dockChk.checked) {
                    if (dockPanel()) appendLog('面板已内嵌到互动/简介页签下方 (实验性)');
                    else {
                        dockChk.checked = false;
                        try { GM_setValue('dlr_dock', false); } catch (e) { }
                        appendLog('页面上没有 互动/简介 侧栏, 面板保持悬浮 (未登录页不挂载侧栏)');
                    }
                } else {
                    undockPanel();
                    appendLog('面板已回到悬浮位置');
                }
            });
            // 一开始就嵌入 (用户要求: 不是等解析完才嵌). 侧栏可能比脚本晚上线, 15s 内每秒重试.
            if (want) {
                let tries = 0;
                const tryDock = () => {
                    if (panel.classList.contains('docked')) return;
                    if (dockPanel()) { appendLog('面板已内嵌到互动/简介页签下方 (实验性)'); return; }
                    if (++tries <= 15) setTimeout(tryDock, 1000);
                    else {
                        dockChk.checked = false;
                        try { GM_setValue('dlr_dock', false); } catch (e) { }
                        appendLog('页面上没有 互动/简介 侧栏, 面板保持悬浮');
                    }
                };
                tryDock();
            }
            // React 切页签/重渲染可能把面板从宿主里甩掉: 1.5s 校验一次, 脱落就挂回去;
            // 侧栏整个消失(退出登录)则退回悬浮. 只读判断 + appendChild, 不写任何几何.
            setInterval(() => {
                try {
                    if (docked()) {
                        if (!panel.isConnected || !dockHost || !dockHost.contains(panel)) {
                            if (!dockPanel()) { undockPanel(); appendLog('侧栏已消失, 面板回到悬浮位置'); }
                        }
                    } else if (dockChk.checked) {
                        dockPanel();   // 开关开着但还没嵌上(侧栏刚上线) → 补挂
                    }
                } catch (e) { }
            }, 1500);
        }

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
                if (panel.classList.contains('docked')) return;   // 内嵌态不可拖 (v3.2.0)
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
            // 恢复拖拽时被折叠的更多设置
            const mb2 = $('dlr-more-b');
            if (mb2 && mb2.dataset.preDragOpen === '1') { setMore(true); delete mb2.dataset.preDragOpen; }
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
            if (k === '' || k === 'Spacebar') {
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


