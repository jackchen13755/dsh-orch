#!/bin/bash
# 环境自愈：把 peer 包链回**宿主那一份**实例。
#
# 为什么必须有这一步（不是可选优化）：
#  - 本插件 import 了 @deepseek-ai/dsh-tools / dsh-llm / schemastery，它们是 peerDependencies，
#    不随插件安装；pnpm/npm 装完插件目录里没有它们，ESM 解析失败 → 宿主里表现为 [no-fiber]。
#  - 必须是**宿主同实例**：schemastery 的 schema 由宿主按实例校验，装副本会踩坑；
#    createUserMessage / defineTool 也应以宿主那份为准。
#  - 反过来，`npm i` 会把「不在依赖树里」的软链当 extraneous 清掉（本机实测过：一次装
#    devDependency 把三条链全剪了，插件随后 [no-fiber]）。
# 所以挂在 postinstall 上，装完自动愈合。
#
# 用法：
#   bash scripts/heal-env.sh                                   # 自动探测宿主
#   DSH_HOST_NODE_MODULES=<宿主>/node_modules bash scripts/heal-env.sh
#   DSH_LINK_PEERS_STRICT=1 bash scripts/heal-env.sh           # 有问题退出码 1
# 退出码：0 = 链就位（含本来就好）；strict 下有问题才 1。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PEERS=("@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-llm" "@deepseek-ai/schemastery" "@deepseek-ai/dsh-session")
STRICT="${DSH_LINK_PEERS_STRICT:-0}"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
[ -x "$NODE_BIN" ] || NODE_BIN="/usr/bin/env node"

# —— 候选宿主 node_modules：优先含完整 @deepseek-ai/dsh 的安装，按 mtime 新者优先 ——
CANDS=()
[ -n "${DSH_HOST_NODE_MODULES:-}" ] && CANDS+=("$DSH_HOST_NODE_MODULES")

full=(); other=()
for pattern in "$HOME"/.npm/_npx/*/node_modules "$HOME"/.dsh/dsh-runtimes/*/node_modules "$HOME"/.dsh/profiles/*/node_modules "$HOME"/dsh-harness/node_modules; do
  for d in $pattern; do
    [ -d "$d" ] || continue
    if [ -f "$d/@deepseek-ai/dsh/package.json" ]; then
      full+=("$(stat -f '%m' "$d/@deepseek-ai/dsh/package.json" 2>/dev/null || echo 0)|$d")
    else
      other+=("$d")
    fi
  done
done

while IFS='|' read -r _ d; do [ -n "$d" ] && CANDS+=("$d"); done < <(printf '%s\n' "${full[@]:-}" | sort -t'|' -k1 -rn)
for d in "${other[@]:-}"; do [ -n "$d" ] && CANDS+=("$d"); done

HOST=""
for c in "${CANDS[@]:-}"; do
  ok=1
  for p in "${PEERS[@]}"; do [ -d "$c/$p" ] || { ok=0; break; }; done
  if [ "$ok" = 1 ]; then HOST="$c"; break; fi
done

# 允许缺 dsh-session：先按 3 个必需 peer 再找一次
if [ -z "$HOST" ]; then
  for c in "${CANDS[@]:-}"; do
    ok=1
    for p in "@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-llm" "@deepseek-ai/schemastery"; do
      [ -d "$c/$p" ] || { ok=0; break; }
    done
    if [ "$ok" = 1 ]; then HOST="$c"; break; fi
  done
fi

if [ -z "$HOST" ]; then
  echo "heal-env: 找不到含 peer 的宿主 node_modules" >&2
  echo "heal-env: 可用 DSH_HOST_NODE_MODULES=<路径> 显式指定" >&2
  [ "$STRICT" = "1" ] && exit 1
  exit 0
fi
echo "heal-env: 宿主 = $HOST"

mkdir -p node_modules/@deepseek-ai
rc=0
for p in "${PEERS[@]}"; do
  name="${p##*/}"
  src="$HOST/$p"
  if [ ! -d "$src" ]; then
    echo "heal-env: 跳过 $p（宿主没有，可选）"
    continue
  fi
  dst="node_modules/$p"
  if [ -e "$dst" ] && [ ! -L "$dst" ] && [ -d "$dst" ]; then
    echo "heal-env: 保留已有的实体目录 $p"
    continue
  fi
  rm -f "$dst" 2>/dev/null
  ln -s "$src" "$dst" 2>/dev/null
  if [ -L "$dst" ]; then echo "heal-env: 链好 $p -> $src"; else echo "heal-env: 链失败 $p" >&2; rc=1; fi
done

# 交叉核对 schemastery 版本与 profile 里的一致（不一致常见于挑错了宿主副本）
PROFILE_SCHEMA="$(dirname "$ROOT")/@deepseek-ai/schemastery/package.json"
if [ -f "$PROFILE_SCHEMA" ]; then
  a="$("$NODE_BIN" -e "try{console.log(require('$PROFILE_SCHEMA').version)}catch(e){console.log('?')}" 2>/dev/null)"
  b="$("$NODE_BIN" -e "try{console.log(require('$ROOT/node_modules/@deepseek-ai/schemastery/package.json').version)}catch(e){console.log('?')}" 2>/dev/null)"
  [ "$a" != "$b" ] && echo "heal-env: ⚠ schemastery 版本不一致（profile=$a 链=$b），可能挑错宿主副本" >&2
fi

if [ "$STRICT" = "1" ] && [ "$rc" != "0" ]; then exit 1; fi
exit 0
