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

get_ver() { git show "$1:$FILE" | grep -m1 -oE '@version[[:space:]]+[^[:space:]]+' | awk '{print $2}'; }
prev="$(get_ver "${hs[1]}")"
cur="$(get_ver "${hs[0]}")"

echo "最近两次触碰 $FILE 的提交：@version $prev -> $cur"
if [ "$prev" = "$cur" ]; then
  echo "::error::$FILE 有改动但 @version 未 bump（仍为 $cur）——Tampermonkey 用户将收不到更新"
  exit 1
fi
echo "版本已 bump ✓"
