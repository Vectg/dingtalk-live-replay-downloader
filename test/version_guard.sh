#!/usr/bin/env bash
# 守卫：改了 .user.js 却没 bump @version（1.6.8 踩过的坑，交给机器拦）。
# 比较「最近两次触碰 .user.js 的提交」里的 @version，相同即失败。
set -euo pipefail
cd "$(dirname "$0")/.."
FILE='钉钉直播回放下载.user.js'

mapfile -t hs < <(git log -5 --format=%H -- "$FILE")
if [ "${#hs[@]}" -lt 2 ]; then
  echo "只有一次提交涉及 $FILE，跳过守卫"
  exit 0
fi

# 全程不用管道：grep -m1 找到第一行就退出，会让上游收到 SIGPIPE（141），
# 在 `set -o pipefail` 下整条管道被判失败——脚本静默中止、什么都不输出。
# 这个坑真实发生过（1.9.12 提交时守卫 exit 255 且无任何输出）。
# 改用 bash 内建 =~ 从变量里匹配，行为完全确定。
get_ver() {
  local txt line
  txt="$(git show "$1:$FILE")" || return 1
  while IFS= read -r line; do
    if [[ "$line" =~ @version[[:space:]]+([^[:space:]]+) ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <<< "$txt"
  return 1
}

prev="$(get_ver "${hs[1]}")" || { echo "::error::读不出上一版 @version，守卫无法判断"; exit 1; }
cur="$(get_ver "${hs[0]}")" || { echo "::error::读不出当前 @version，守卫无法判断"; exit 1; }

if [ -z "$prev" ] || [ -z "$cur" ]; then
  echo "::error::@version 解析失败（prev='$prev' cur='$cur'）"
  exit 1
fi

echo "最近两次触碰 $FILE 的提交：@version $prev -> $cur"
if [ "$prev" = "$cur" ]; then
  echo "::error::$FILE 有改动但 @version 未 bump（仍为 $cur）——Tampermonkey 用户将收不到更新"
  exit 1
fi
echo "版本已 bump ✓"
