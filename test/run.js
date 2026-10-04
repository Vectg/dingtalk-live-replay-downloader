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