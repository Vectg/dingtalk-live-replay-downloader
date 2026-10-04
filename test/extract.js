'use strict';
// 从**已发布的 .user.js** 里按函数名抽取源码执行 —— 测的必须是真正发布出去的代码，
// 重写一份等价实现来测会随原文件漂移而失去意义。
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', '钉钉直播回放下载.user.js');

// 脚本里所有被测函数都在 IIFE 内层，缩进恰好 4 空格。扫一次建索引，
// 免得每抽一个函数就重跑一遍正则。
const FN_START = /^ {4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
let SRC = '';
const START_INDEX = new Map();

function scan() {
    SRC = fs.readFileSync(SRC_PATH, 'utf8');
    START_INDEX.clear();
    FN_START.lastIndex = 0;
    let m;
    while ((m = FN_START.exec(SRC)) !== null) START_INDEX.set(m[1], m.index);
}
scan();

// 判断某个 '/' 是正则字面量的开头还是除号：看它前一个非空白字符。
// 出现在 ( , = : [ ! & | ? { ; return 等位置时，前一个 token 期待表达式 → 是正则。
const REGEX_PRECEDERS = /[({[,=:!&|?;+\-*%~^]$|\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
function isRegexStart(src, i) {
    for (let j = i - 1; j >= 0; j--) {
        const c = src[j];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
        return REGEX_PRECEDERS.test(src.slice(Math.max(0, j - 12), j + 1));
    }
    return true;
}

// 跳过字符串字面量、正则与注释，否则其中的引号/大括号会被当成结构边界
function skipLiteral(src, i) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
        const e = src.indexOf('\n', i);
        return e < 0 ? src.length : e;
    }
    if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        return e < 0 ? src.length : e + 2;
    }
    if (c === '/' && isRegexStart(src, i)) {
        // 正则字面量：跳过 /.../ 内的字符类 [...]（其中可能有未转义的 '/'）
        let j = i + 1, inClass = false;
        while (j < src.length) {
            const d = src[j];
            if (d === '\\') { j += 2; continue; }
            if (d === '[') inClass = true;
            else if (d === ']') inClass = false;
            else if (d === '/' && !inClass) return j + 1;
            else if (d === '\n') break;   // 正则不能跨行，视为普通字符
            j++;
        }
        return i + 1;
    }
    if (c === "'" || c === '"' || c === '`') {
        const q = c;
        for (let j = i + 1; j < src.length; j++) {
            if (src[j] === '\\') { j++; continue; }
            if (src[j] === q) return j + 1;
        }
        return src.length;
    }
    return -1;
}

// 按花括号配平切出完整函数体。旧写法靠「缩进 4 空格的闭合 }」定位，
// 遇到函数体里恰好有 4 空格闭合的嵌套块（对象字面量、回调）就会提前截断。
function extractFn(name) {
    const start = START_INDEX.get(name);
    if (start === undefined) {
        throw new Error('function not found: ' + name +
            '（需是 4 空格缩进的顶层 function 声明）');
    }
    const bodyStart = SRC.indexOf('{', start);
    if (bodyStart < 0) throw new Error('no body for: ' + name);
    let depth = 0;
    for (let i = bodyStart; i < SRC.length; i++) {
        const skipped = skipLiteral(SRC, i);
        if (skipped > i) { i = skipped - 1; continue; }
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) return SRC.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces for: ' + name);
}

// names: 要导出的函数（含其相互依赖，一起抽进同一作用域）
// deps:  外部依赖（getText/appendLog 等）以参数注入
function loadFns(names, deps) {
    deps = deps || {};
    const code = names.map(extractFn).join('\n\n');
    const keys = Object.keys(deps);
    const factory = new Function(...keys, code + '\nreturn {' + names.join(', ') + '};');
    return factory(...keys.map((k) => deps[k]));
}

module.exports = { SRC_PATH, extractFn, loadFns, reload: scan };
