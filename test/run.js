'use strict';
// 单元测试：函数源码由 extract.js 从**已发布**的 .user.js 里原样抽取，
// 所以这里测的就是用户真正装到 Tampermonkey 里的那份代码。
const { loadFns } = require('./extract.js');
const { extractFn } = require('./extract.js');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fails.push(name + (extra ? '  →  ' + extra : ''));
}
function eq(actual, expected, name) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    ok(a === b, name, 'got ' + a + ', want ' + b);
}
function throws(fn, name) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    ok(threw, name, 'expected a throw, got none');
}
function section(t) { process.stdout.write('\n' + t + '\n'); }

// ------------------------------------------------- 抽取器自身（守卫测试的有效性）
// 如果 extract 静默截断了函数体，下面所有断言都可能在测残缺代码而看不出来，
// 所以先验证抽取结果本身是完整、可解析的。
section('extract（抽取器自检）');
{
    // 配平：抽出的源码花括号必须闭合，且能被 Function 构造器编译
    for (const name of ['sanitize', 'fmtBytes', 'parseTimeArg', 'clipSegments',
        'parseAttributes', 'fetchAndParseM3u8', 'fixMp4Duration', 'parseSpsToDims',
        'findSpsCandidates', 'boxIter', 'mergeBuffers', 'parseUrl']) {
        let code = '';
        try {
            code = extractFn(name);
        } catch (e) {
            ok(false, 'extract ' + name, e.message);
            continue;
        }
        let bad = null;
        // 用 node 直接编译：语法错或括号不配平都会抛
        try {
            new Function(code);   // eslint-disable-line no-new-func
        } catch (e) {
            bad = e.message;
        }
        ok(!bad, 'extract ' + name + ' → 语法完整可编译', bad);
        ok(code.includes('{') && code.trimEnd().endsWith('}'),
            'extract ' + name + ' → 以 } 正常收尾（未被截断）');
    }

    // 跨行模板字符串里的 ${ } 不能被当成函数体结束
    const dl = extractFn('downloadBlob');
    ok(dl.includes('anchorFallback'), '含嵌套函数定义的 downloadBlob 抽全了');
    ok(/function cleanup\(\)/.test(dl), 'downloadBlob 内嵌 cleanup 完整');

    // 正则字面量里的引号不能破坏解析（parseAttributes 用 /"[^"]*"/）
    const pa = extractFn('parseAttributes');
    ok(pa.includes('while ((m = re.exec(attrText))'), 'parseAttributes 的 while 循环完整');
    ok(pa.includes('return out;'), 'parseAttributes 尾部 return 存在');

    throws(() => extractFn('noSuchFunction'), '抽取不存在的函数 → 抛错');
}

async function main() {
// ---------------------------------------------------------------- 文件名/文本
section('sanitize / safeName / stamp');
{
    const { sanitize, safeName } = loadFns(['sanitize', 'safeName']);
    eq(sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j', 'sanitize 替换全部非法字符');
    eq(sanitize('  标题  '), '标题', 'sanitize 去首尾空白');
    eq(sanitize(''), null, 'sanitize 空串 → null');
    eq(sanitize('x'.repeat(200)).length, 120, 'sanitize 截断到 120 字符');
    eq(sanitize('a\r\nb\tc'), 'a__b_c', 'sanitize CRLF 各自替换 + 制表 → 下划线');
    eq(safeName('我的回放.mp4', 'def'), '我的回放', 'safeName 去掉 .mp4 后缀');
    eq(safeName('a.TS', 'def'), 'a', 'safeName 去 .TS 后缀（忽略大小写）');
    eq(safeName('', 'def'), 'def', 'safeName 空 → fallback');
    eq(safeName(null, null), 'replay', 'safeName 全空 → replay');
    eq(safeName('///', 'def'), '___', 'safeName 全非法字符 → 兜底而非 null');
}

section('fmtBytes / fmtTime');
{
    const { fmtBytes, fmtTime } = loadFns(['fmtBytes', 'fmtTime']);
    eq(fmtBytes(0), '0 B', 'fmtBytes 0');
    eq(fmtBytes(-5), '0 B', 'fmtBytes 负数 → 0 B');
    eq(fmtBytes(512), '512 B', 'fmtBytes B');
    eq(fmtBytes(1024), '1 KB', 'fmtBytes KB 进位');
    eq(fmtBytes(1536), '2 KB', 'fmtBytes KB 四舍五入');
    eq(fmtBytes(1048576), '1.0 MB', 'fmtBytes MB');
    eq(fmtBytes(340 * 1048576), '340.0 MB', 'fmtBytes 预估体积文案');
    eq(fmtTime(0), '00:00', 'fmtTime 0');
    eq(fmtTime(90), '01:30', 'fmtTime 分');
    eq(fmtTime(3723), '1:02:03', 'fmtTime 时');
    eq(fmtTime(-5), '00:00', 'fmtTime 负数 → 00:00');
}

section('compareVersions（更新检查）');
{
    const { compareVersions } = loadFns(['compareVersions']);
    eq(compareVersions('1.9.8', '1.9.7'), 1, '小版本更大');
    eq(compareVersions('1.9.7', '1.9.8'), -1, '小版本更小');
    eq(compareVersions('1.9', '1.9.0'), 0, '缺位当 0 → 相等');
    eq(compareVersions('2.0', '10.0'), -1, '按段比较而非字典序');
    eq(compareVersions('', '0.0.0'), 0, '空串 → 0.0.0');
    eq(compareVersions(undefined, '0.0.1'), -1, 'undefined 安全');
}

// ---------------------------------------------------------------- 截取
section('parseTimeArg');
{
    const { parseTimeArg } = loadFns(['parseTimeArg', 'fmtTime']);
    eq(parseTimeArg('45', '开始'), 45, '裸数字 = 秒（≤59）');
    eq(parseTimeArg('1:30', '开始'), 90, 'mm:ss');
    eq(parseTimeArg('1:02:03', '开始'), 3723, 'hh:mm:ss');
    eq(parseTimeArg('90:00', '开始'), 5400, '两位时首位是分钟，可超 59');
    // 裸数字上限 59 是刻意设计（消除「90 是秒还是分」的歧义），报错信息引导改写
    throws(() => parseTimeArg('90', '开始'), '裸数字 >59 报错（提示改用 mm:ss）');
    eq(parseTimeArg('１２：３０', '开始'), 750, '全角数字+全角冒号自动修复');
    eq(parseTimeArg(' 1 : 30 ', '开始'), 90, '去空白');
    eq(parseTimeArg('', '开始'), null, '空 → null');
    eq(parseTimeArg(null, '开始'), null, 'null → null');
    throws(() => parseTimeArg('12:60', '开始'), '秒位 >59 报错');
    throws(() => parseTimeArg('1:70:00', '开始'), '分钟位 >59 报错');
    throws(() => parseTimeArg('1:2:3:4', '开始'), '超过两层冒号报错');
    throws(() => parseTimeArg('1::2', '开始'), '冒号连写报错');
    throws(() => parseTimeArg('abc', '开始'), '字母报错');
    throws(() => parseTimeArg('-5', '开始'), '负号报错');
}

section('面板拖拽定位 clampPanelPos / posToRightBottom（v2.4.0）');
{
    const { clampPanelPos, posToRightBottom } = loadFns(['clampPanelPos', 'posToRightBottom']);
    const VW = 1258, VH = 566, W = 392, H = 736;   // H > VH：面板比视口还高（真实情况）
    const GAP = 8;

    // 视口比面板还窄（手机竖屏 / 小窗）：x 必须夹住，否则面板整个消失到屏幕外
    eq(clampPanelPos(0, 0, W, H, 400, 300).x, GAP, '视口窄于面板 → x 夹到 gap');

    // x 四边钳制
    eq(clampPanelPos(-999, -999, W, H, VW, VH).x, GAP, 'x<0 → 夹到左边界');
    eq(clampPanelPos(-999, -999, W, H, VW, VH).y, GAP, 'y<0 → 夹到上边界');
    eq(clampPanelPos(99999, 99999, W, H, VW, VH).x, VW - W - GAP, 'x 过大 → 夹到右边界');

    // y 只夹上界：面板高于视口时也允许往下拖（否则永远贴顶，= 拖不动）
    eq(clampPanelPos(100, 99999, W, H, VW, VH).y, 99999, 'y 过大 → 不夹（页面可滚）');
    const TALL = 1000;
    eq(clampPanelPos(100, 99999, W, H, VW, TALL).y, 99999, '视口够高也不夹 y（刻意设计）');

    // 区间内原样返回
    eq(clampPanelPos(100, 100, W, H, VW, VH).x, 100, '区间内 x 原样');
    eq(clampPanelPos(100, 100, W, H, VW, VH).y, 100, '区间内 y 原样');

    // right/bottom 反算自洽，且永不为负
    const p = posToRightBottom(100, 100, W, H, VW, VH);
    eq(p.left, '100px', 'posToRightBottom left');
    eq(p.top, '100px', 'posToRightBottom top');
    eq(p.right, (VW - 100 - W) + 'px', 'posToRightBottom right 反算正确');
    eq(p.bottom, '0px', '面板高于视口 → bottom 夹到 0 而非负数');

    // 拖到左上角
    const q = posToRightBottom(0, 0, W, H, VW, VH);
    eq(q.left, '8px', 'x<0 → 夹到 gap 后再反算');
    eq(q.right, (VW - GAP - W) + 'px', '拖到左上角后 right 反算');

    // 幂等：反算结果再拿回坐标，位置不变
    const rt = posToRightBottom(250, 60, W, H, VW, VH);
    eq(parseInt(rt.left, 10), 250, '往返一致 x');
    eq(parseInt(rt.top, 10), 60, '往返一致 y');

    // right/bottom 永远 ≥ 0（负值会让浏览器当成反向偏移，面板瞬移到右上角）
    const neg = posToRightBottom(-500, -500, W, H, VW, VH);
    eq(neg.right, (VW - GAP - W) + 'px', '极端左上位移 → right 仍正确');
    eq(neg.bottom, '0px', '极端左上位移 → bottom 不为负');
}

section('clipTimeHint / normalizeClipText（截取时间单位自动识别 v2.3.0）');
{
    const { clipTimeHint, normalizeClipText, parseTimeArg } = loadFns(
        ['clipTimeHint', 'normalizeClipText', 'parseTimeArg', 'fmtTime', 'stripClipNoise']);

    // 单位上限：≥1 小时才给 hh:mm:ss，否则 mm:ss
    eq(clipTimeHint(1813.3).unit, 'mm:ss', '真实回放 1812.9 秒（30 分钟）→ mm:ss');
    eq(clipTimeHint(3600).unit, 'hh:mm:ss', '正好 1 小时 → hh:mm:ss');
    eq(clipTimeHint(1812882).unit, 'hh:mm:ss', 'API 给的是毫秒量级：1812882 秒 → hh:mm:ss');
    eq(clipTimeHint(7200).unit, 'hh:mm:ss', '2 小时 → hh:mm:ss');
    eq(clipTimeHint(36000).unit, 'hh:mm:ss', '10 小时 → hh:mm:ss（小时位不限于 99）');
    // 时长未知 → 不预设上限，但也不能崩
    eq(clipTimeHint(0).unit, 'mm:ss', '时长未知 → 保守 mm:ss');
    eq(clipTimeHint(0).capHint, null, '时长未知 → capHint 为 null');
    eq(clipTimeHint(NaN).capHint, null, 'NaN → capHint 为 null');
    eq(clipTimeHint(undefined).capHint, null, 'undefined → capHint 为 null');
    eq(clipTimeHint(-5).capHint, null, '负数 → capHint 为 null');
    eq(clipTimeHint(90).capHint, '01:30', 'capHint 用 fmtTime 形态');
    // v3.0.4: capHint 必须按**用户要填的同一个 unit** 渲染，否则照抄提示会得到别的时刻。
        // 实际契约（先看 clipTimeHint 的阈值再写断言，别臆想）：
        //   >= 3600s → hh:mm:ss，小时位不补零（fmtTime 的行为，1 小时就是 "1:00:00"）
        //   <  3600s → mm:ss，保留秒、分钟位补零（90 秒 = "01:30"，不是 "2:00"）
        // 关键回归点是 mm:ss 分支必须保留秒 —— 曾一度写成 Math.round(dur/60)+':00'，
        // 90 秒会变成 "2:00"，用户照抄就只剩 2 分钟。
        eq(clipTimeHint(5400).capHint, '1:30:00', '5400s 已达 1 小时 → 走 hh:mm:ss，小时位不补零');
        eq(clipTimeHint(59).capHint, '00:59', 'mm:ss 形态下不足 1 分钟保留秒');
        eq(clipTimeHint(90).capHint, '01:30', 'mm:ss 形态下 90 秒写成 01:30 而不是 2:00');
        eq(clipTimeHint(3599).capHint, '59:59', 'mm:ss 的上边界（差 1 秒切形态）');
        eq(clipTimeHint(3600).capHint, '1:00:00', '整点切到 hh:mm:ss，提示同步切成三段形态');
        eq(clipTimeHint(3661).capHint, '1:01:01', 'hh:mm:ss 形态保留秒');

    // mm:ss 形态下的规范化
    eq(normalizeClipText('1:2', 'mm:ss'), '1:02', 'mm:ss 秒位补零');
    eq(normalizeClipText('90:0', 'mm:ss'), '90:00', 'mm:ss 分钟位不补零（90:00 保持）');
    eq(normalizeClipText('45', 'mm:ss'), '45', '裸数字不足两位不動');
    eq(normalizeClipText('', 'mm:ss'), '', '空 → 空');
    eq(normalizeClipText(null, 'mm:ss'), '', 'null → 空');

    // hh:mm:ss 形态下的规范化
    eq(normalizeClipText('1:2:3', 'hh:mm:ss'), '01:02:03', 'hh:mm:ss 全段补零');
    eq(normalizeClipText('1:30', 'hh:mm:ss'), '1:30', '两段有歧义 → 原样不改写（交给 parseTimeArg）');
    eq(normalizeClipText('100:00:00', 'hh:mm:ss'), '100:00:00', '10 小时级不被截断');
    eq(normalizeClipText('2:00', 'hh:mm:ss'), '2:00', '两段 → 不猜小时位');
    eq(normalizeClipText('45', 'hh:mm:ss'), '45', '裸数字 → 原样');

    // 全角/空白/零宽字符：与 parseTimeArg 同规格
    eq(normalizeClipText('１：３０', 'mm:ss'), '1:30', '全角数字+全角冒号');
    eq(normalizeClipText(' 1 : 30 ', 'mm:ss'), '1:30', '去空白');
    // 零宽字符用码点构造：测试文件里直接写字面量会被编辑工具悄悄吃掉
    // （U+200B 那条就这么变成了普通 '1:30'，断言通过但什么都没测到）。
    const zw = (cp) => '1:' + String.fromCharCode(cp) + '30';
    eq(normalizeClipText(zw(0x200B), 'mm:ss'), '1:30', '去零宽空格 U+200B');
    eq(normalizeClipText(zw(0x200C), 'mm:ss'), '1:30', '去零宽不连字 U+200C');
    eq(normalizeClipText(zw(0x200D), 'mm:ss'), '1:30', '去零宽连字 U+200D');
    eq(normalizeClipText(zw(0xFEFF), 'mm:ss'), '1:30', '去 BOM U+FEFF');
    eq(normalizeClipText(zw(0x00A0), 'mm:ss'), '1:30', '去不换行空格 U+00A0');

    // 非法字符原样交给 parseTimeArg 报错，不得在这里静默改写
    eq(normalizeClipText('1:3a', 'mm:ss'), '1:3a', '含字母 → 原样返回');
    eq(normalizeClipText('::', 'mm:ss'), '::', '冒号连写 → 原样返回');
    eq(normalizeClipText('1:2:3:4', 'hh:mm:ss'), '1:2:3:4', '四段 → 原样返回');

    // 回归：曾把非两段输入静默截断成 '01'（浏览器验收抓到，单测当时漏了）。
    // 每种形态 × 每种层数都必须「要么正确规范化、要么原样返回」，绝不能丢字符。
    // 例外：hh:mm:ss 下的三段是唯一会正确规范化的形态（1:2:3 → 01:02:03），
    // 但 4 段及以上仍必须原样。
    for (const unit of ['mm:ss', 'hh:mm:ss']) {
        for (const v of ['1:2:3:4', '1:2:3:4:5', '9:8:7:6:5']) {
            eq(normalizeClipText(v, unit), v, unit + ' 下 ' + v + ' → 原样（不截断）');
        }
    }
    for (const v of ['1:2:3', '12:34:56']) {
        eq(normalizeClipText(v, 'mm:ss'), v, 'mm:ss 下 ' + v + ' → 原样（不截断）');
    }
    eq(normalizeClipText('5', 'mm:ss'), '05', 'mm:ss 裸数字补零成两位');
    eq(normalizeClipText('5', 'hh:mm:ss'), '5', 'hh:mm:ss 裸数字原样');

    // 关键不变量：规范化是「同值不同写法」，解析结果必须一致
    eq(parseTimeArg(normalizeClipText('1:2', 'mm:ss'), '开始'), 62, '规范化不改变时刻（1:2 → 62s）');
    eq(parseTimeArg(normalizeClipText('1:2:3', 'hh:mm:ss'), '开始'), 3723, 'hh 形态同值');
}

section('clipSegments（按切片边界对齐）');
{
    const { clipSegments } = loadFns(['clipSegments', 'fmtTime']);
    const segs = [0, 1, 2, 3, 4, 5].map((i) => ({ url: i + '.ts', start: i * 10, dur: 10, seq: i }));
    const full = clipSegments(segs, null, null);
    eq(full.segs.length, 6, 'null 区间 → 全量');
    eq(full.range, null, 'null 区间 → range 为 null');
    eq(clipSegments(segs, 0, 30).segs.map((s) => s.seq), [0, 1, 2], '0~30s → 3 片');
    eq(clipSegments(segs, 10, 20).segs.map((s) => s.seq), [1], '边界重合时只留有交集的片');
    const c = clipSegments(segs, 0, 100);
    eq(c.segs.length, 6, '超出总时长 → 截到末尾');
    eq(c.range.clamped, true, 'clamped 标记为 true');
    throws(() => clipSegments(segs, 60, null), '开始时间超出总时长报错');
    throws(() => clipSegments(segs, 50, 10), '结束早于开始报错');
    throws(() => clipSegments(segs, -1, 10), '负数报错');
    throws(() => clipSegments([], 0, 10), '空切片列表报错');
}

// ---------------------------------------------------------------- URL / 属性
section('resolveUrl / parseAttributes / parseUrl');
{
    const { resolveUrl, parseAttributes, parseUrl } = loadFns(['resolveUrl', 'parseAttributes', 'parseUrl']);
    eq(resolveUrl('https://a.com/p/i.m3u8', 'seg1.ts'), 'https://a.com/p/seg1.ts', '相对路径');
    eq(resolveUrl('https://a.com/p/i.m3u8', '/x/seg1.ts'), 'https://a.com/x/seg1.ts', '根相对路径');
    eq(resolveUrl('https://a.com/p/i.m3u8', 'https://b.com/s.ts'), 'https://b.com/s.ts', '绝对路径原样');
    eq(resolveUrl('https://a.com/p/i.m3u8', ''), '', '空 → 空串');
    eq(parseAttributes('BANDWIDTH=1234,CODECS="avc1.4d401f,mp4a.40.2"'),
        { BANDWIDTH: '1234', CODECS: 'avc1.4d401f,mp4a.40.2' }, '属性解析 + 引号剥离 + 大写 key');
    eq(parseAttributes('RESOLUTION=1280x720'), { RESOLUTION: '1280x720' }, '无引号属性');
    eq(parseUrl('https://n.dingtalk.com/dingding/live-room/index.html?roomId=abc&liveUuid=def-1'),
        { roomId: 'abc', liveUuid: 'def-1' }, '完整 URL');
    eq(parseUrl('?roomId=abc&liveUuid=def-1'), { roomId: 'abc', liveUuid: 'def-1' }, '裸 query');
    throws(() => parseUrl('https://n.dingtalk.com/?roomId=abc'), '缺 liveUuid 报错');
}

// ---------------------------------------------------------------- 二进制
section('mergeBuffers');
{
    const { mergeBuffers } = loadFns(['mergeBuffers']);
    const out = mergeBuffers([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
    eq(Array.from(out), [1, 2, 3], '拼接含空数组');
    eq(mergeBuffers([]).length, 0, '空输入 → 空输出');
    eq(Array.from(mergeBuffers([new Uint8Array([9]), new Uint8Array([8, 7])])), [9, 8, 7], '顺序保持');
}

section('hexToBytes / seqIv / keyIv（AES-128 IV 推导）');
{
    const { hexToBytes, seqIv, keyIv } = loadFns(['hexToBytes', 'seqIv', 'keyIv']);
    eq(Array.from(hexToBytes('0a0b')), [10, 11], 'hex → 字节');
    eq(Array.from(hexToBytes('0x0A0B')), [10, 11], '0x 前缀 + 大写');
    eq(hexToBytes('zz').length, 1, '非法 hex 不抛，宽松补 0');
    eq(Array.from(seqIv(1)).slice(12), [0, 0, 0, 1], '序号写进 IV 后 4 字节');
    eq(Array.from(seqIv(0)).slice(12), [0, 0, 0, 0], '序号 0');
    eq(Array.from(keyIv(null, 7)).slice(12), [0, 0, 0, 7], '无 IV → 用序号');
    const k = '00'.repeat(15) + 'ff';
    eq(Array.from(keyIv(k, 7))[15], 255, '显式 IV 原样使用');
    eq(Array.from(keyIv('0011', 7)).slice(12), [0, 0, 0, 7], 'IV 长度非 16 → 回退到序号');
}

// ---------------------------------------------------------------- MP4 box
section('boxIter / findBox / writeInt');
{
    const { boxIter, findBox, writeInt } = loadFns(['boxIter', 'findBox', 'writeInt']);

    function box(type, ...parts) {
        const body = Buffer.concat(parts);
        const h = Buffer.alloc(8);
        h.writeUInt32BE(body.length + 8, 0);
        h.write(type, 4, 'latin1');
        return Buffer.concat([h, body]);
    }
    const inner = box('mdhd', Buffer.alloc(24));
    const trak = box('trak', box('tkhd', Buffer.alloc(20)), box('mdia', inner));
    const moov = box('moov', trak);
    const buf = Buffer.concat([box('ftyp', Buffer.alloc(8)), moov]);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    eq(boxIter(dv, 0, buf.length).map((b) => b.type), ['ftyp', 'moov'], '顶层 box 顺序');
    eq(findBox(dv, 0, buf.length, 'moov').size, moov.length, 'findBox 命中 moov');
    eq(findBox(dv, 0, buf.length, 'moov/trak/mdia/mdhd').type, 'mdhd', 'findBox 多级路径');
    eq(findBox(dv, 0, buf.length, 'moov/nope'), null, '找不到 → null');

    // size==1 的 64 位 box 头
    const big = Buffer.alloc(24);
    big.writeUInt32BE(1, 0); big.write('free', 4, 'latin1');
    big.writeBigUInt64BE(BigInt(24), 8);
    eq(boxIter(new DataView(big.buffer, big.byteOffset, big.length), 0, 24)
        .map((b) => [b.type, b.hdr, b.size]), [['free', 16, 24]], '64 位 box 头 (size==1)');

    // 声明长度超出缓冲 → 停止，不越界读
    const lying = Buffer.alloc(16);
    lying.writeUInt32BE(9999, 0); lying.write('moov', 4, 'latin1');
    eq(boxIter(new DataView(lying.buffer, lying.byteOffset, 16), 0, 16).length, 0,
        'size 越界 → 停止遍历');

    const w = Buffer.alloc(12);
    const wdv = new DataView(w.buffer, w.byteOffset, w.byteLength);
    writeInt(wdv, 0, 4, 4294967294);
    eq(wdv.getUint32(0), 4294967294, 'writeInt 32 位');
    writeInt(wdv, 4, 8, 123456789);
    eq(Number(wdv.getBigUint64(4)), 123456789, 'writeInt 64 位');
}

// ------------------------------------------- fixMp4Duration（1.6.0 的核心修复）
section('fixMp4Duration（哨兵 duration 修补）');
{
    // fixMp4Duration 内部引用 boxIter/findBox/writeInt，且异常被它自己的 try/catch
    // 吞掉（只记日志、不影响产出）——所以依赖必须一起抽进来，缺一个就静默不生效，
    // appendLog 也要注入，否则报错信息连日志都写不出来。
    const fixLog = [];
    const { fixMp4Duration, boxIter, findBox } = loadFns(
        ['fixMp4Duration', 'boxIter', 'findBox', 'writeInt'],
        { appendLog: (m) => { fixLog.push(m); } }
    );

    function box(type, ...parts) {
        const body = Buffer.concat(parts);
        const h = Buffer.alloc(8);
        h.writeUInt32BE(body.length + 8, 0);
        h.write(type, 4, 'latin1');
        return Buffer.concat([h, body]);
    }
    function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
    function fullBox(type, version, flags, ...p) {
        const vh = Buffer.alloc(4);
        vh.writeUInt8(version, 0); vh.writeUIntBE(flags, 1, 3);
        return box(type, vh, ...p);
    }
    const SENTINEL = 0xFFFFFFFF;

    // 一个分片：tfdt(base) + trun(1 个 sample, dur 30000ms@timescale1000)
    function moof(base, dur) {
        const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
        const tfdt = fullBox('tfdt', 1, 0, (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(base), 0); return b; })());
        // flags 0x301 = data-offset + sample-duration + sample-size
        const trun = fullBox('trun', 0, 0x000301, u32(1), (() => { const b = Buffer.alloc(4); b.writeInt32BE(0, 0); return b; })(), u32(dur), u32(1024));
        return box('moof', fullBox('mfhd', 0, 0, u32(1)), box('traf', tfhd, tfdt, trun));
    }
    function build(mvDur, samples) {
        const TS = 1000;
        // mvhd v0: version+flags(4) creation(4) modification(4) timescale(4) duration(4) rate(4) volume(2) reserved(2) reserved(8) matrix(36) predefined(24) nextTrackId(4)
        const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(TS), u32(mvDur),
            u32(0x00010000), Buffer.from([0x01, 0x00]), Buffer.alloc(2), Buffer.alloc(8),
            Buffer.alloc(36), Buffer.alloc(24), u32(2));
        // tkhd v0: version+flags(4) creation(4) modification(4) track_ID(4) reserved(4) duration(4) reserved(8) layer(2) altgroup(2) volume(2) reserved(2) matrix(36) width(4) height(4)
        const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(mvDur),
            Buffer.alloc(8), Buffer.from([0x00, 0x00]), Buffer.from([0x00, 0x00]),
            Buffer.from([0x00, 0x00]), Buffer.alloc(2), Buffer.alloc(36),
            u32(1920 << 16), u32(1080 << 16));
        // mdhd v0: fullBox 已吃掉 version+flags(4)，其后 payload 为
//   creation(4) modification(4) timescale(4) duration(4) language(2) pre_defined(2)
        // 脚本读 mdBase+12 取 timescale、+16 取 duration（mdBase 已跳过 vf），与规范一致
        const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(SENTINEL),
            Buffer.from([0x55, 0xc4]), Buffer.alloc(2));
        // mdhd 已由 fullBox 生成完整 box（含 size+type 头），不要再套 box()
        const moov = box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd)));
        const parts = [box('ftyp', Buffer.from('isom')), moov];
        for (const s of samples) parts.push(moof(s.base, s.dur), box('mdat', Buffer.alloc(1024)));
        return new Uint8Array(Buffer.concat(parts));
    }

    // version 0 各 box 的 duration 偏移（相对 box payload 起点，ISO/IEC 14496-12）：
    //   mvhd: vf(4) cre(4) mod(4) timescale(4) → duration@16
    //   mdhd: 同 mvhd                                    → duration@16
    //   tkhd: vf(4) cre(4) mod(4) track_ID(4) res(4)  → duration@20
    const DUR_OFF = { mvhd: 16, mdhd: 16, tkhd: 20 };
    function readDur(u8, path) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const top = {};
        for (const b of boxIter(dv, 0, dv.byteLength)) top[b.type] = b;
        const bx = findBox(dv, top.moov.start + top.moov.hdr, top.moov.start + top.moov.size, path);
        return dv.getUint32(bx.start + bx.hdr + DUR_OFF[bx.type]);
    }

    // 两个分片各 30s → 真实时长 60s
    const u8 = build(SENTINEL, [{ base: 0, dur: 30000 }, { base: 30000, dur: 30000 }]);
    const sizeBefore = u8.length;
    const fixed = fixMp4Duration(u8);
    eq(fixed.length, sizeBefore, '修补后文件大小不变');
    eq(readDur(fixed, 'mvhd'), 60000, 'mvhd duration 60s');
    eq(readDur(fixed, 'trak/tkhd'), 60000, 'tkhd duration 60s');
    eq(readDur(fixed, 'trak/mdia/mdhd'), 60000, 'mdhd duration 60s');

    const ok1 = build(60000, [{ base: 0, dur: 30000 }, { base: 30000, dur: 30000 }]);
    eq(readDur(fixMp4Duration(ok1), 'mvhd'), 60000, '已是正常值 → 不改不动');

    // 只有 ftyp/free，没有 moov+moof → 应原样返回，不做任何修补
    const noMoof = new Uint8Array(Buffer.concat([
        box('ftyp', Buffer.from('isom')), box('free', Buffer.alloc(8)),
    ]));
    eq(fixMp4Duration(noMoof).length, noMoof.length, '无 moov/moof → 原样返回');

    // 有 moov 但没有 moof（纯 MP4，非 fragmented）→ 同样不修补
    const noMoof2 = build(SENTINEL, []);
    eq(readDur(fixMp4Duration(noMoof2), 'mvhd'), SENTINEL, '无 moof → 哨兵值保持不动');

    eq(fixMp4Duration(new Uint8Array(4)).length, 4, '垃圾输入不抛异常');
    eq(fixLog.length, 0, '正常路径无异常日志');
}

// ---------------------------------------------------------------- m3u8 解析
// fetchAndParseM3u8 只依赖 getText（取播放列表）与 appendLog（记日志），
// 打桩成内存字典即可覆盖整个切片索引逻辑：多码率 / AES / MAP / BYTERANGE。
section('fetchAndParseM3u8（切片索引）');
{
    function makeParser(playlistMap) {
        const log = [];
        const { fetchAndParseM3u8, resolveUrl, parseAttributes } = loadFns(
            ['fetchAndParseM3u8', 'resolveUrl', 'parseAttributes'],
            {
                getText: async (u) => {
                    if (!(u in playlistMap)) throw new Error('404 ' + u);
                    return playlistMap[u];
                },
                appendLog: (m) => log.push(m),
            }
        );
        return { parse: (u, depth, wantRes) => fetchAndParseM3u8(u, depth || 0, wantRes || ''), log };
    }

    // --- 基础单码率 ---
    const basic = makeParser({
        'https://cdn/x.m3u8': [
            '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:30', '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXTINF:30.0,', 'seg0.ts', '#EXTINF:30.0,', 'seg1.ts', '#EXTINF:30.5,', 'seg2.ts',
            '#EXT-X-ENDLIST', '',
        ].join('\n'),
    });
    const r1 = await basic.parse('https://cdn/x.m3u8');
    eq(r1.segments.length, 3, '基础：3 片');
    eq(r1.segments.map((s) => s.url), ['https://cdn/seg0.ts', 'https://cdn/seg1.ts', 'https://cdn/seg2.ts'], '切片 URL 解析为绝对路径');
    eq(r1.segments.map((s) => s.sequence), [0, 1, 2], 'sequence 从 MEDIA-SEQUENCE 递增');
    eq(r1.segments.map((s) => s.start), [0, 30, 60], 'start 时间轴累加');
    eq(r1.totalDur, 90.5, '总时长 90.5s');
    eq(r1.encrypted, false, '未加密');
    eq(r1.fmp4, false, '非 fMP4');
    eq(r1.segments.map((s) => s.dur), [30, 30, 30.5], '每片时长');

    // --- MEDIA-SEQUENCE 偏移 ---
    const seq = makeParser({
        'https://cdn/x.m3u8': '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n',
    });
    eq((await seq.parse('https://cdn/x.m3u8')).segments.map((s) => s.sequence), [100, 101],
        'MEDIA-SEQUENCE=100 → 首片 sequence 100');

    // --- 多码率：按带宽降序，挑 wantRes ---
    const multi = makeParser({
        'https://cdn/master.m3u8': [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080', 'high.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720', 'mid.m3u8',
        ].join('\n'),
        'https://cdn/low.m3u8': '#EXTM3U\n#EXTINF:10,\nl0.ts\n',
        'https://cdn/high.m3u8': '#EXTM3U\n#EXTINF:10,\nh0.ts\n',
        'https://cdn/mid.m3u8': '#EXTM3U\n#EXTINF:10,\nm0.ts\n',
    });
    const mAuto = await multi.parse('https://cdn/master.m3u8');
    eq(mAuto.segments[0].url, 'https://cdn/h0.ts', '自动 → 最高带宽（1080p）');
    eq(mAuto.variants.map((v) => v.bandwidth), [3000000, 1500000, 800000], '变体按带宽降序');
    const mPick = await multi.parse('https://cdn/master.m3u8', 0, '1280x720');
    eq(mPick.segments[0].url, 'https://cdn/m0.ts', '指定分辨率 → 选中对应变体');
    const mMiss = await multi.parse('https://cdn/master.m3u8', 0, '999x999');
    eq(mMiss.segments[0].url, 'https://cdn/h0.ts', '分辨率找不到 → 回落最高带宽');
    ok(multi.log.some((m) => m.includes('找不到分辨率')), '找不到分辨率时写日志');

    // --- AES-128 + IV ---
    const aes = makeParser({
        'https://cdn/x.m3u8': [
            '#EXTM3U',
            '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF',
            '#EXTINF:10,', 'e0.ts',
            '#EXT-X-KEY:METHOD=NONE',            // 后续切片不加密
            '#EXTINF:10,', 'e1.ts',
        ].join('\n'),
    });
    const rAes = await aes.parse('https://cdn/x.m3u8');
    eq(rAes.encrypted, true, '存在 AES-128 → encrypted=true');
    eq(rAes.segments[0].key.uri, 'https://cdn/key.bin', 'key URI 绝对化');
    eq(rAes.segments[0].key.iv, '0x0123456789ABCDEF0123456789ABCDEF', '保留 IV 原文');
    eq(rAes.segments[1].key, null, 'METHOD=NONE → key 置空');

    // --- fMP4: EXT-X-MAP ---
    const fmp4 = makeParser({
        'https://cdn/x.m3u8': [
            '#EXTM3U',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:10,', 's0.m4s', '#EXTINF:10,', 's1.m4s',
        ].join('\n'),
    });
    const rFmp4 = await fmp4.parse('https://cdn/x.m3u8');
    eq(rFmp4.fmp4, true, '有 EXT-X-MAP → fmp4=true');
    eq(rFmp4.initSegment.url, 'https://cdn/init.mp4', 'initSegment 取自 MAP');
    eq(rFmp4.segments[0].map.url, 'https://cdn/init.mp4', '每片携带 map');

    // --- fMP4: 仅靠 .m4s 后缀判定 ---
    const fmp4b = makeParser({
        'https://cdn/x.m3u8': '#EXTM3U\n#EXTINF:10,\na.m4s\n#EXTINF:10,\nb.m4s\n',
    });
    eq((await fmp4b.parse('https://cdn/x.m3u8')).fmp4, true, '.m4s 后缀 → fmp4=true');

    // --- BYTERANGE：带 @offset 与省略 @offset 两种写法 ---
    const br = makeParser({
        'https://cdn/x.m3u8': [
            '#EXTM3U',
            '#EXTINF:10,', '#EXT-X-BYTERANGE:1000@0', 'a.ts',
            '#EXTINF:10,', '#EXT-X-BYTERANGE:2000@1000', 'a.ts',   // 同一文件续段
            '#EXTINF:10,', '#EXT-X-BYTERANGE:500', 'a.ts',         // 省略 offset
        ].join('\n'),
    });
    const rBr = await br.parse('https://cdn/x.m3u8');
    eq(rBr.segments[0].byterange, { length: 1000, offset: 0 }, 'BYTERANGE 长度@0');
    eq(rBr.segments[1].byterange, { length: 2000, offset: 1000 }, 'BYTERANGE 续段偏移');
    eq(rBr.segments[2].byterange, { length: 500, offset: null }, 'BYTERANGE 省略 offset → null');
    eq(rBr.segments[2].byterange.offset, null, '第三片 offset 确为 null（脚本原样保留）');

    // --- 异常输入 ---
    const empty = makeParser({ 'https://cdn/x.m3u8': '#EXTM3U\n#EXT-X-VERSION:3\n' });
    let threw = '';
    try { await empty.parse('https://cdn/x.m3u8'); } catch (e) { threw = e.message; }
    ok(threw.includes('无切片'), '只有标签无切片 → 报「m3u8 无切片」', threw);

    const miss = makeParser({});
    threw = '';
    try { await miss.parse('https://cdn/nope.m3u8'); } catch (e) { threw = e.message; }
    ok(threw.includes('404'), '取不到播放列表 → 抛出底层错误', threw);

    const deep = makeParser({});
    threw = '';
    try { await deep.parse('https://cdn/x.m3u8', 9); } catch (e) { threw = e.message; }
    ok(threw.includes('嵌套层级过多'), '嵌套过深 → 报层级超限', threw);

    // --- CRLF / 空白行容忍 ---
    const messy = makeParser({
        'https://cdn/x.m3u8': '#EXTM3U\r\n\r\n  #EXT-X-VERSION:3  \r\n#EXTINF:10,\r\n a.ts \r\n',
    });
    eq((await messy.parse('https://cdn/x.m3u8')).segments.length, 1, 'CRLF + 空行 + 行首尾空白均容忍');
}

// ---------------------------------------------------------------- SPS 分辨率
// parseSpsToDims 是纯位运算函数，用 test/sps.js 的 bit-writer 构造合法 SPS 喂它，
// 覆盖 Baseline 简化路径、High profile 扩展路径、frame_cropping 与 MBAFF。
section('parseSpsToDims（H.264 SPS → 分辨率）');
{
    const { parseSpsToDims } = loadFns(['parseSpsToDims']);
    const { makeSps } = require('./sps.js');

    const d1 = parseSpsToDims(makeSps(80, 45, 66, 30));          // 1280×720
    eq([d1.width, d1.height], [1280, 720], 'Baseline 1280×720（80×45 MB）');
    eq([d1.profileIdc, d1.levelIdc], [66, 30], '读出 profile_idc=66 / level_idc=30');

    const d2 = parseSpsToDims(makeSps(40, 30, 66, 30));          // 640×480
    eq([d2.width, d2.height], [640, 480], 'Baseline 640×480（40×30 MB）');

    // profile 100 在扩展列表里 → 会读 chroma_format_idc 等字段
    const d3 = parseSpsToDims(makeSps(80, 45, 100, 31));
    eq([d3.width, d3.height], [1280, 720], 'High profile 扩展路径 1280×720');
    eq([d3.profileIdc, d3.levelIdc], [100, 31], 'High profile_idc=100 / level=31');

    // 1080 不是 16 的整数倍：68 MB = 1088 行，crop 掉 4 个 crop unit（4:2:0 下 1 unit = 2 行）
    const d4 = parseSpsToDims(makeSps(120, 68, 100, 40, [0, 0, 0, 4]));
    eq([d4.width, d4.height], [1920, 1080], 'frame_cropping 生效：1088 → 1080');

    // MBAFF：frame_mbs_only_flag=0 时高度 ×2
    const d5 = parseSpsToDims(makeSps(80, 45, 66, 30, null, 0));
    eq([d5.width, d5.height], [1280, 1440], 'MBAFF（frame_mbs_only_flag=0）高度 ×2');

    // 非法输入应被挡下，而不是返回垃圾值
    let msg = '';
    try { parseSpsToDims(Uint8Array.from([0x67, 0x42])); } catch (e) { msg = e.message; }
    ok(msg.includes('越界'), 'NAL 过短 → 抛「越界」而非返回垃圾', msg);
    msg = '';
    try { parseSpsToDims(new Uint8Array(0)); } catch (e) { msg = e.message; }
    ok(msg.length > 0, '空输入抛异常而非崩溃', msg);
    msg = '';
    // 上限校验：宽 8000 MB = 128000px > 7680 上限 → 应被挡
    try { parseSpsToDims(makeSps(8000, 45, 66, 30)); } catch (e) { msg = e.message; }
    ok(msg.includes('分辨率越界'), '超宽（128000px）→ 抛「分辨率越界」', msg);
    msg = '';
    // 微小但非零的分辨率是合法的，脚本只拒 <=0
    eq((() => { const d = parseSpsToDims(makeSps(1, 1, 66, 30)); return [d.width, d.height]; })(),
        [16, 16], '1×1 MB → 16×16 合法（脚本下限只到 >0）');

    // 分辨率上下限边界（脚本硬校验 width≤7680 / height≤4320）
    const atMaxW = parseSpsToDims(makeSps(480, 45, 66, 40));
    eq([atMaxW.width, atMaxW.height], [7680, 720], '宽恰好 7680（上限）通过');
    const atMaxH = parseSpsToDims(makeSps(80, 270, 66, 40));
    eq([atMaxH.width, atMaxH.height], [1280, 4320], '高恰好 4320（上限）通过');
    msg = '';
    try { parseSpsToDims(makeSps(481, 45, 66, 40)); } catch (e) { msg = e.message; }
    ok(msg.includes('分辨率越界'), '宽 7696（超上限 1px）被挡', msg);
    msg = '';
    try { parseSpsToDims(makeSps(80, 271, 66, 40)); } catch (e) { msg = e.message; }
    ok(msg.includes('分辨率越界'), '高 4336（超上限 16px）被挡', msg);
}

// ---------------------------------------------------------------- 完成/失败通知
// notify() 只依赖两个模块级开关，beep 内部依赖 AudioContext —— 都要能优雅降级。
section('notify（完成/失败通知）');
{
    // 用一个假 AudioContext 验证：开关关闭时完全不碰音频；开启时按完成/失败
    // 发出不同音数（完成 2 声上行、失败 3 声下行）。
    function makeNotify(opts) {
        // 开关通过 setNotifyFlags 注入（脚本里是闭包外的 notifyFlags 对象，
        // 直接当参数注入遮蔽不了，必须把 setter 一起抽进来）
        const { notify, beep, primeNotifyAudio, setNotifyFlags, setAudioCtx, getAudioCtx } = loadFns(
            ['notify', 'beep', 'primeNotifyAudio', 'setNotifyFlags', 'setAudioCtx', 'getAudioCtx']
        );
        setNotifyFlags(opts.desktop, opts.sound);
        return { notify, beep, primeNotifyAudio, setNotifyFlags, setAudioCtx, getAudioCtx };
    }

    // --- 提示音：开关关闭时不创建任何音频节点 ---
    {
        let madeNodes = 0;
        const fakeAudioCtx = {
            state: 'running',
            currentTime: 0,
            destination: {},
            createOscillator: () => {
                madeNodes++;
                return {
                    type: '', frequency: {},
                    connect() { }, start() { }, stop() { },
                };
            },
            createGain: () => ({
                gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } },
                connect() { },
            }),
        };
        const { notify, setAudioCtx } = makeNotify({ desktop: false, sound: false });
        setAudioCtx(fakeAudioCtx);   // 预置上下文，若开关真的生效就会被用到
        notify('t', 'msg', true);
        notify('t', 'msg', false);
        eq(madeNodes, 0, '提示音关闭 → 不创建任何振荡器节点');
    }

    // --- 提示音开启：完成 2 声、失败 3 声，且频率上行/下行 ---
    {
        const made = [];
        const fakeAudioCtx = {
            state: 'running',
            currentTime: 0,
            destination: {},
            createOscillator: () => {
                const o = {
                    type: '', freq: 0,
                    frequency: { set value(v) { o.freq = v; } },
                    connect() { }, start(t) { made.push({ freq: o.freq, start: t }); }, stop() { },
                };
                return o;
            },
            createGain: () => ({
                gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } },
                connect() { },
            }),
        };
        const { notify, setAudioCtx } = makeNotify({ desktop: false, sound: true });
        setAudioCtx(fakeAudioCtx);
        made.length = 0;
        notify('完成', 'x', true);
        eq(made.length, 2, '完成 → 2 声');
        ok(made[1].freq > made[0].freq, '完成提示音上行', made.map((m) => Math.round(m.freq)).join(' → '));
        made.length = 0;
        notify('失败', 'x', false);
        eq(made.length, 3, '失败 → 3 声');
        ok(made[1].freq < made[0].freq, '失败提示音下行', made.map((m) => Math.round(m.freq)).join(' → '));
    }

    // --- GM_notification 调用形态 ---
    {
        const seen = [];
        const savedGM = global.GM_notification;
        global.GM_notification = (o) => seen.push(o);
        const savedN = global.Notification;
        global.Notification = undefined;
        try {
            const { notify } = makeNotify({ desktop: true, sound: false });
            notify('标题', '正文', true);
            eq(seen.length, 1, '桌面通知开启 → 调用一次 GM_notification');
            eq(seen[0].title, '标题', '通知标题透传');
            eq(seen[0].text, '正文', '通知正文透传');
            ok(typeof seen[0].onclick === 'function', '通知带 onclick（点通知能回面板）');
            ok(seen[0].timeout > 0, '通知有自动消失时间');
        } finally {
            global.GM_notification = savedGM;
            global.Notification = savedN;
        }
    }

    // --- 桌面通知关闭 → 完全不通知 ---
    {
        let called = 0;
        const savedGM = global.GM_notification;
        global.GM_notification = () => { called++; };
        try {
            const { notify } = makeNotify({ desktop: false, sound: false });
            notify('t', 'x', true);
            eq(called, 0, '桌面通知关闭 → 不调用 GM_notification');
        } finally {
            global.GM_notification = savedGM;
        }
    }
}

// ---------------------------------------------------------------- 失败片清单
// 「只重试失败切片」依赖一个不变量：partial.datas 里非空的槽位就是好片，
// 空槽位就是待重试的片。把这条不变量单独测出来，避免改动下载逻辑时悄悄破坏它。
section('失败片清单推导');
{
    // 与脚本内同构的推导：哪些片缺失
    // 判定必须与脚本一致：!d || !d.length —— 零长度 Uint8Array 是「真值」对象，
    // 只写 !d 会把空切片当成好片，正是 1.9.7 完整性校验要抓的那类坏片。
    const missingOf = (datas) => {
        const out = [];
        for (let i = 0; i < datas.length; i++) {
            if (!datas[i] || !datas[i].length) out.push(i + 1);
        }
        return out;
    };
    const bytes = (n) => new Uint8Array(n);

    eq(missingOf([bytes(10), bytes(10), bytes(10)]), [], '全部齐全 → 无失败片');
    eq(missingOf([bytes(10), null, bytes(10)]), [2], '中间缺一片');
    eq(missingOf([null, null]), [1, 2], '开头连续缺两片');
    eq(missingOf([bytes(1), null, null, bytes(1)]), [2, 3], '中间连续缺两片');
    eq(missingOf([bytes(1), new Uint8Array(0), bytes(1)]), [2],
        '零长度切片（空数据）也算失败片 —— 与脚本 badIdx 的判定一致');
    eq(missingOf([bytes(1), undefined, bytes(1)]), [2], 'undefined 槽位算失败片');
    eq(missingOf(new Array(60).fill(null)).length, 60, '全部失败 → 60 片全在清单里');

    // 关键不变量：重试时好片绝不能被重新下载。
    // 模拟下载流程 —— partial 命中后，只有空槽位进入抓取循环。
    function simulateRun(datas) {
        const fetched = [];
        let cursor = 0;
        const worker = async () => {
            while (true) {
                let i = cursor++;
                if (i >= datas.length) return;
                while (i < datas.length && datas[i]) i = cursor++;   // 脚本里的跳过逻辑
                if (i >= datas.length) return;
                fetched.push(i + 1);
                datas[i] = bytes(10);
            }
        };
        return Promise.all([worker(), worker(), worker()]).then(() => fetched);
    }

    eq(await simulateRun([bytes(10), null, bytes(10), null, bytes(10)]), [2, 4],
        '重试只抓缺失的两片，好片一片不碰');
    eq(await simulateRun([bytes(10), bytes(10), bytes(10)]), [],
        '全片命中缓存 → 不发起任何请求');
    eq(await simulateRun([null, null, null, null]), [1, 2, 3, 4], '全片缺失 → 全部抓取');
}

// ---------------------------------------------------------------- 诊断报告
// redactUrl 是安全关键项：诊断文本用户会直接贴到公开 issue 里，
// 不能把播放地址里的签名带出去。
section('诊断报告 redactUrl（签名抹除）');
{
    const { redactUrl } = loadFns(['redactUrl']);

    eq(redactUrl('https://cdn/x.m3u8?auth_key=abcdef123&t=99'),
        'https://cdn/x.m3u8?auth_key=<已抹除>&t=99', 'auth_key 被抹除');
    eq(redactUrl('https://cdn/x.m3u8?authKey=SECRET&x=1'),
        'https://cdn/x.m3u8?authKey=<已抹除>&x=1', '驼峰 authKey 也抹除');
    eq(redactUrl('https://cdn/x.ts?token=SECRET'),
        'https://cdn/x.ts?token=<已抹除>', 'token 抹除');
    eq(redactUrl('https://cdn/x.ts?sign=SECRET&expires=1'),
        'https://cdn/x.ts?sign=<已抹除>&expires=1', 'sign 抹除但保留其他参数');
    eq(redactUrl('https://cdn/x.ts?signature=SECRET'),
        'https://cdn/x.ts?signature=<已抹除>', 'signature 抹除');
    eq(redactUrl('https://cdn/x.ts?a=1'), 'https://cdn/x.ts?a=1', '无签名参数 → 原样');
    eq(redactUrl(''), '', '空串');
    eq(redactUrl(undefined), '', 'undefined → 空串');
    // 大小写不敏感
    eq(redactUrl('https://cdn/x.ts?AUTH_KEY=SECRET'),
        'https://cdn/x.ts?AUTH_KEY=<已抹除>', '大写 AUTH_KEY 也抹除');
    // 值里含 & 时不能截断后面的参数
    const tricky = redactUrl('https://cdn/x.ts?auth_key=a%26b&keep=1');
    ok(tricky.includes('keep=1'), '签名值含转义 & 时不吞掉后续参数', tricky);
    ok(!tricky.includes('a%26b'), '签名原值不泄露', tricky);
    // 多个签名参数
    const multi = redactUrl('https://cdn/x.ts?sign=A&token=B&sign=C&keep=9');
    ok(!multi.includes('A&') && !multi.includes('=B'), '同名的多个签名参数都抹除', multi);
    ok(multi.includes('keep=9'), '非签名参数保留', multi);
    eq(redactUrl(null), '', 'null → 空串');
}

// ---------------------------------------------------------------- 自定义分辨率
section('自定义分辨率');
{
    const { parseResInput, pickResVariant } = loadFns(['parseResInput', 'pickResVariant']);

    // --- 输入解析 ---
    eq(parseResInput('1280x720'), '1280x720', '标准写法');
    eq(parseResInput('1920X1080'), '1920x1080', '大写 X');
    eq(parseResInput('1920×1080'), '1920x1080', '乘号 ×');
    eq(parseResInput('1920X1080'), '1920x1080', 'Unicode ✕');
    eq(parseResInput(' 1280 x 720 '), '1280x720', '含空格');
    eq(parseResInput('1280：720'), '1280x720', '中文冒号');
    eq(parseResInput('０１２８０ｘ７２０'), '1280x720', '全角数字与全角 x');
    throws(() => parseResInput(''), '空 → 报错');
    throws(() => parseResInput('abc'), '非数字 → 报错');
    throws(() => parseResInput('1280'), '缺高度 → 报错');
    throws(() => parseResInput('8x8'), '低于 16 下限 → 报错');
    throws(() => parseResInput('99999x100'), '超宽上限 → 报错');
    throws(() => parseResInput('100x99999'), '超高上限 → 报错');
    throws(() => parseResInput('1280x720x60'), '三段 → 报错');

    // --- 档位匹配 ---
    const variants = [
        { res: '1920x1080', bandwidth: 3000000 },
        { res: '1280x720', bandwidth: 1500000 },
        { res: '960x540', bandwidth: 800000 },
        { res: '640x360', bandwidth: 400000 },
        { res: '', bandwidth: 200000 },          // 未标注分辨率，应被跳过
    ];
    const pick = (target, ow, oh) => {
        const v = pickResVariant(variants, target, ow, oh);
        return v ? v.res : null;
    };
    eq(pick('1280x720', 1920, 1080), '1280x720', '精确命中');
    eq(pick('1366x768', 1920, 1080), '1280x720', '略大目标 → 取不超过目标的最大档');
    eq(pick('1100x619', 1920, 1080), '1280x720', '目标偏小但惩罚后仍取更接近的大档');
    eq(pick('900x506', 1920, 1080), '960x540', '小目标 → 取略小的档');
    eq(pick('320x180', 1920, 1080), '640x360', '低于所有档位 → 取最小档');
    // 原始分辨率以内的档位才允许出现在下拉里；比原始还大的要跳过
    eq(pick('1280x720', 1280, 720), '1280x720', '原始=目标 → 命中原档');
    eq(pick('1920x1080', 1280, 720), '1280x720', '目标高于原始 → 回落到原始档');
    eq(pick('1280x720', 0, 0), '1280x720', '未知原始分辨率 → 不做上限过滤');
    eq(pickResVariant([], '1280x720', 1920, 1080), null, '无档位 → null');
    eq(pickResVariant(null, '1280x720', 1920, 1080), null, 'variants 为 null → null');
    // 只有未标注分辨率的档位 → 无从匹配
    eq(pickResVariant([{ res: '', bandwidth: 1 }], '1280x720', 1920, 1080), null,
        '全部档位未标分辨率 → null');
    // 尺寸非法的档位要被跳过，不能让 NaN 污染比较
    eq(pickResVariant([{ res: '0x0', bandwidth: 9 }, { res: '640x360', bandwidth: 4 }],
        '1280x720', 1920, 1080).res, '640x360', '非法尺寸档位被跳过');
}

// ---------------------------------------------------------------- 导出 m3u8
// 产物要能被 ffmpeg / VLC 直接吃，所以标签与顺序必须严格合规。
section('buildM3u8（导出播放列表）');
{
    const { buildM3u8 } = loadFns(['buildM3u8']);

    const seg = (i, over) => Object.assign({
        url: 'https://cdn/seg' + i + '.ts',
        sequence: i, dur: 30, start: i * 30,
        key: null, map: null, byterange: null,
    }, over || {});
    const parsed = (segs, over) => Object.assign({
        segments: segs, encrypted: false, fmp4: false, initSegment: null, totalDur: 0,
    }, over || {});

    // --- 基础 ---
    const t1 = buildM3u8(parsed([seg(0), seg(1), seg(2)]), 'x').split('\n');
    eq(t1[0], '#EXTM3U', '首行是 #EXTM3U');
    ok(t1.includes('#EXT-X-VERSION:3'), '含 VERSION 声明');
    ok(t1.includes('#EXT-X-PLAYLIST-TYPE:VOD'), '含 PLAYLIST-TYPE:VOD');
    eq(t1[t1.length - 2], '#EXT-X-ENDLIST', '倒数第二行是 ENDLIST');
    eq(t1[t1.length - 1], '', '以空行结尾');
    ok(!t1.some((l) => l === '#EXT-X-BYTERANGE:'), '无 byterange 时不写该标签');
    ok(!t1.some((l) => l.startsWith('#EXT-X-KEY')), '未加密时不写 KEY');
    ok(!t1.some((l) => l.startsWith('#EXT-X-MAP')), '非 fMP4 时不写 MAP');

    // --- TARGETDURATION 必须 >= 任意 EXTINF（规范硬要求） ---
    const t2 = buildM3u8(parsed([seg(0, { dur: 30 }), seg(1, { dur: 30.4 }), seg(2, { dur: 12 })])).split('\n');
    eq(t2[t2.indexOf('#EXT-X-TARGETDURATION:31')], '#EXT-X-TARGETDURATION:31',
        'TARGETDURATION 向上取整到最长片（30.4 → 31）');
    const t3 = buildM3u8(parsed([seg(0, { dur: 10 })])).split('\n');
    eq(t3[t3.indexOf('#EXT-X-TARGETDURATION:10')], '#EXT-X-TARGETDURATION:10', '整秒时长不额外进位');
    const t4 = buildM3u8(parsed([seg(0, { dur: 0 })])).split('\n');
    ok(t4.includes('#EXT-X-TARGETDURATION:1'), '时长为 0 时保底为 1（规范要求 >= 1）');

    // --- MEDIA-SEQUENCE 取首片序号 ---
    const t5 = buildM3u8(parsed([seg(100), seg(101)])).split('\n');
    ok(t5.includes('#EXT-X-MEDIA-SEQUENCE:100'), 'MEDIA-SEQUENCE 用首片的 sequence');

    // --- EXTINF 与 URL 必须成对交替 ---
    const t6 = buildM3u8(parsed([seg(0, { dur: 30 }), seg(1, { dur: 30 })])).split('\n');
    const body = t6.slice(t6.indexOf('#EXTINF:30,'));
    eq(body.slice(0, 4), ['#EXTINF:30,', 'https://cdn/seg0.ts', '#EXTINF:30,', 'https://cdn/seg1.ts'],
        'EXTINF 与切片 URL 严格交替');

    // --- 时长格式：去掉多余的尾随零 ---
    const t7 = buildM3u8(parsed([seg(0, { dur: 30 }), seg(1, { dur: 30.5 }), seg(2, { dur: 12.25 })])).split('\n');
    ok(t7.includes('#EXTINF:30,'), '30 → "30"（不写成 30.000）');
    ok(t7.includes('#EXTINF:30.5,'), '30.5 保留一位小数');
    ok(t7.includes('#EXTINF:12.25,'), '12.25 保留两位小数');

    // --- AES-128 ---
    const enc = parsed([seg(0, { key: { method: 'AES-128', uri: 'https://cdn/k.bin', iv: '0xABC' } }), seg(1)],
        { encrypted: true });
    const t8 = buildM3u8(enc).split('\n');
    ok(t8.includes('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn/k.bin",IV=0xABC'),
        'KEY 标签含 URI 与 IV', t8.find((l) => l.startsWith('#EXT-X-KEY')));
    const encNoIv = parsed([seg(0, { key: { method: 'AES-128', uri: 'https://cdn/k.bin', iv: '' } })], { encrypted: true });
    const t9 = buildM3u8(encNoIv).split('\n');
    ok(t9.some((l) => l === '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn/k.bin"'),
        '无 IV 时不写空 IV 参数');

    // --- fMP4：MAP 必须在第一个切片之前 ---
    const f = parsed([seg(0, { map: { url: 'https://cdn/init.mp4' } }), seg(1)],
        { fmp4: true, initSegment: { url: 'https://cdn/init.mp4' } });
    const t10 = buildM3u8(f).split('\n');
    ok(t10.includes('#EXT-X-MAP:URI="https://cdn/init.mp4"'), 'fMP4 含 MAP 标签');
    ok(t10.indexOf('#EXT-X-MAP') < t10.indexOf('#EXTINF:30,'),
        'MAP 出现在第一个 EXTINF 之前（规范要求）', String(t10.indexOf('#EXT-X-MAP')));

    // --- BYTERANGE 两种写法 ---
    const br = parsed([
        seg(0, { byterange: { length: 1000, offset: 0 } }),
        seg(1, { byterange: { length: 2000, offset: 1000 } }),
        seg(2, { byterange: { length: 500, offset: null } }),
    ]);
    const t11 = buildM3u8(br).split('\n');
    ok(t11.includes('#EXT-X-BYTERANGE:1000@0'), '带 @offset');
    ok(t11.includes('#EXT-X-BYTERANGE:2000@1000'), '续段 @offset');
    ok(t11.includes('#EXT-X-BYTERANGE:500'), '省略 @ 时只写长度');
    ok(!t11.includes('#EXT-X-BYTERANGE:500@'), 'offset 为 null 不写 @null');
    // BYTERANGE 必须在对应 URL 之前
    ok(t11.indexOf('#EXT-X-BYTERANGE:1000@0') < t11.indexOf('https://cdn/seg0.ts'),
        'BYTERANGE 在其切片 URL 之前');

    // --- 空列表不应崩 ---
    const t12 = buildM3u8(parsed([])).split('\n');
    ok(t12.includes('#EXT-X-ENDLIST'), '空列表也产出合法结尾');
    ok(t12.includes('#EXT-X-TARGETDURATION:1'), '空列表 TARGETDURATION 保底 1');
    eq(buildM3u8({ segments: [] }).split('\n').filter((l) => l.startsWith('http')).length, 0,
        '空列表不含任何切片 URL');
}

// ---------------------------------------------------------------- 下载队列
section('队列输入解析');
{
    // parseQueueLine 内部会调 parseUrl 拆整段 URL，必须一起抽进来
    const { parseQueueLine, parseQueueInput } = loadFns(
        ['parseQueueLine', 'parseQueueInput', 'parseUrl']);
    const UUID = 'bce267ae-eccf-4065-b0af-54ca3d404b06';
    const RID = 'xzRKYCIBkT';

    // --- 单行：整段 URL ---
    eq(parseQueueLine('https://n.dingtalk.com/dingding/live-room/index.html?roomId=' + RID + '&liveUuid=' + UUID,
        '第1行'), { roomId: RID, liveUuid: UUID }, '整段 URL');
    eq(parseQueueLine('?roomId=' + RID + '&liveUuid=' + UUID, '第1行'),
        { roomId: RID, liveUuid: UUID }, '裸查询串');

    // --- 单行：roomId + liveUuid ---
    eq(parseQueueLine(RID + ' ' + UUID, '第1行'), { roomId: RID, liveUuid: UUID }, '空格分隔');
    eq(parseQueueLine(RID + ',' + UUID, '第1行'), { roomId: RID, liveUuid: UUID }, '逗号分隔');
    eq(parseQueueLine(RID + ';' + UUID, '第1行'), { roomId: RID, liveUuid: UUID }, '分号分隔');
    eq(parseQueueLine(RID + '\t' + UUID, '第1行'), { roomId: RID, liveUuid: UUID }, 'Tab 分隔');
    eq(parseQueueLine(RID + '   ' + UUID + '  ', '第1行'), { roomId: RID, liveUuid: UUID }, '多余空白');

    // --- 单行：带标签写法 ---
    eq(parseQueueLine('roomId ' + RID + ' liveUuid ' + UUID, '第1行'),
        { roomId: RID, liveUuid: UUID }, 'roomId/liveUuid 带标签');
    eq(parseQueueLine('roomid=' + RID + ' liveuuid=' + UUID, '第1行'),
        { roomId: RID, liveUuid: UUID }, '小写标签 + 等号');

    // --- 单行：只给 liveUuid ---
    eq(parseQueueLine(UUID, '第1行'), { roomId: '', liveUuid: UUID }, '只给 liveUuid → roomId 留空');

    // --- 单行：错误 ---
    throws(() => parseQueueLine('', '第3行'), '空行报错');
    throws(() => parseQueueLine('   ', '第3行'), '纯空白报错');
    throws(() => parseQueueLine('随便写点什么', '第3行'), '无法识别时报错');
    let msg = '';
    try { parseQueueLine('', '第7行'); } catch (e) { msg = e.message; }
    ok(msg.includes('第7行'), '报错信息带行号', msg);

    // --- 多行 ---
    const r1 = parseQueueInput([RID + ' ' + UUID, RID + ' other-uuid-2', '?roomId=' + RID + '&liveUuid=u3'].join('\n'));
    eq(r1.out.length, 3, '三行 → 三个任务');
    eq(r1.errs, [], '无错误');
    eq(r1.out.map((x) => x.liveUuid), [UUID, 'other-uuid-2', 'u3'], '顺序保持');

    // 空行与注释行被忽略，但不影响行号
    const r2 = parseQueueInput(['', '# 注释', '   ', RID + ' ' + UUID].join('\n'));
    eq(r2.out.length, 1, '空行/注释行被忽略');
    eq(r2.errs, [], '忽略的行不算错误');

    // 混合：好的留下，坏的单独报告
    const r3 = parseQueueInput([RID + ' ' + UUID, '乱写', RID + ' u2'].join('\n'));
    eq(r3.out.length, 2, '有效行照常解析');
    eq(r3.errs.length, 1, '无效行单独报出');
        // 只断言语义（行号 + 格式提示），不绑死空格：文案统一会把「第 2 行」的空格压掉
    ok(/第\s*2\s*行/.test(r3.errs[0]) && /格式不对/.test(r3.errs[0]),
        '错误信息指向具体行号并说明格式', r3.errs[0]);

    // CRLF 与末尾空行
    eq(parseQueueInput(RID + ' ' + UUID + '\r\n' + RID + ' u2\r\n').out.length, 2, 'CRLF 正确切分');
    eq(parseQueueInput('').out.length, 0, '空文本 → 零任务');
    eq(parseQueueInput(null).out.length, 0, 'null → 零任务');
    eq(parseQueueInput('# 只有注释').out.length, 0, '只有注释 → 零任务');

    // 行数很多也不该出错（队列上限在 UI 层管）
    const many = Array.from({ length: 200 }, (_, i) => RID + ' uuid-' + i).join('\n');
    eq(parseQueueInput(many).out.length, 200, '200 行正常解析');
}

// ---------------------------------------------------------------- 智能调度
section('智能调度');
{
    const { greedyOrder, makeConcurrencyGovernor } = loadFns(['greedyOrder', 'makeConcurrencyGovernor']);

    // --- 贪心取片顺序 ---
    eq(greedyOrder([10, 20, 30], null), [2, 1, 0], '大的切片优先');
    eq(greedyOrder([30, 20, 10], null), [0, 1, 2], '本来就有序时保持');
    eq(greedyOrder([10, 30, 20, 40], null), [3, 1, 2, 0], '最大的一片排最前');
    // 同体积按原序，保证可复现（否则每次刷新下载顺序都变，缓存命中会抖）
    eq(greedyOrder([10, 10, 10], null), [0, 1, 2], '同体积按原序');
    eq(greedyOrder([10, 10, 10, 10], null), [0, 1, 2, 3], '同体积长列表也稳定');
    // 未知体积不能打乱已知体积的优先级
    eq(greedyOrder([null, 50, null], null), [1, 0, 2], '已知体积优先于未知');
    eq(greedyOrder([null, null, null], null), [0, 1, 2], '全部未知 → 原序');
    // 断点缓存里已有的片要跳过
    const skip = [true, false, true, false];
    eq(greedyOrder([10, 20, 30, 40], skip), [3, 1], '跳过已在缓存的片');
    eq(greedyOrder([10, 20, 30, 40], [true, true, true, true]), [], '全部已缓存 → 空序列');
    eq(greedyOrder([], null), [], '空列表');
    // 结果长度必须与可用片数一致，且每片只出现一次
    const many = Array.from({ length: 30 }, (_, i) => (i * 37) % 11);
    const ord = greedyOrder(many, null);
    eq(ord.length, 30, '不丢片');
    eq(new Set(ord).size, 30, '不重复');
    // 非单调输入也要正确排序
    eq(greedyOrder([5, 100, 3, 50, 7], null), [1, 3, 4, 0, 2], '乱序输入正确排序（100,50,7,5,3）');

    // --- 自适应并发 ---
    // 从 2 起步，全部成功 → 每个窗口加 1，直到上限
    let g = makeConcurrencyGovernor({ min: 1, max: 4, start: 2, window: 2, winMs: 1e9 });
    eq(g.value, 2, '初始并发 = start');
    g.note(1000);
    eq(g.value, 2, '未满窗口不加');
    g.note(1000);
    eq(g.value, 3, '满一个窗口 +1');
    g.note(1000); g.note(1000);
    eq(g.value, 4, '继续爬升');
    g.note(1000); g.note(1000); g.note(1000); g.note(1000);
    eq(g.value, 4, '不超过上限');

    // 失败立刻降并发
    g = makeConcurrencyGovernor({ min: 1, max: 8, start: 6, window: 4, winMs: 1e9 });
    eq(g.value, 6, '起步 6');
    eq(g.fail(), 5, '失败一次 → 降 1');
    eq(g.fail(), 4, '再失败 → 降 2');
    eq(g.fail(), 3, '继续降');
    for (let i = 0; i < 10; i++) g.fail();
    eq(g.value, 1, '一直失败降到下限');
    for (let i = 0; i < 10; i++) g.fail();
    eq(g.value, 1, '不跌破下限');

    // 降过之后重新成功能回升（不是单向下降）
    g = makeConcurrencyGovernor({ min: 1, max: 8, start: 4, window: 2, winMs: 1e9 });
    g.fail();
    eq(g.value, 3, '先降');
    g.note(500, 1000); g.note(500, 1000);
    eq(g.value, 4, '恢复后能回升');

    // 字节数为 0 / 缺失时不加（速度算不出 0，不该误判为「很快」）
    g = makeConcurrencyGovernor({ min: 1, max: 4, start: 1, window: 2, winMs: 1e9 });
    g.note(0); g.note(0);
    eq(g.value, 1, '零字节不加并发');
    g = makeConcurrencyGovernor({ min: 1, max: 4, start: 1, window: 2, winMs: 1e9 });
    g.note(undefined); g.note(null);
    eq(g.value, 1, '缺字节数不加并发');

    // start 超界要夹紧
    eq(makeConcurrencyGovernor({ min: 2, max: 6, start: 99, window: 1, winMs: 1e9 }).value, 6, 'start 超上限 → 夹到 max');
    eq(makeConcurrencyGovernor({ min: 2, max: 6, start: 0, window: 1, winMs: 1e9 }).value, 2, 'start 低于下限 → 夹到 min');
    eq(makeConcurrencyGovernor({ min: 4, max: 2, start: 3, window: 1, winMs: 1e9 }).value, 4,
        'max < min 时取 min 而不是产生非法区间');

    // stats 能反映当前状态
    g = makeConcurrencyGovernor({ min: 1, max: 8, start: 3, window: 5, winMs: 1e9 });
    g.note(2000, 12345);
    const st = g.stats();
    eq([st.min, st.max], [1, 8], 'stats 含区间');
    eq(st.lastSpeed, 12345, 'stats 含最近速度');
}
}   // ← 关闭 async function main()

// ---------------------------------------------------------------- 报告
function report() {
    process.stdout.write('\n' + '-'.repeat(56) + '\n');
    const total = pass + fails.length;
    if (fails.length) {
        process.stdout.write('FAIL  ' + pass + '/' + total + ' 通过，' + fails.length + ' 项失败：\n');
        for (const f of fails) process.stdout.write('  ✗ ' + f + '\n');
        process.exit(1);
    }
    process.stdout.write('PASS  ' + pass + '/' + total + ' 断言全部通过\n');
}

main().then(report, (e) => {
    process.stdout.write('FAIL  未捕获异常: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});