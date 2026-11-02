#!/bin/bash
# dsh-orch 自检（无编译步骤：源码就是 lib/index.js，宿主直接加载）。
# 原因：本机只有 Electron/asar 打包的 DSH，没有带 packages/ 的源码 checkout，
# 脚手架默认的 tsc 链路不可用；宿主只要求 entry 导出 { name, inject, apply }。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== 1. 语法检查 ==="
for f in lib/*.js; do
  node --check "$f"
  echo "  ok: $f"
done

echo "=== 2. 导出形状检查 ==="
node -e '
const src = require("fs").readFileSync("lib/index.js", "utf8");
for (const key of ["export const name", "export const inject", "export function apply"]) {
  if (!src.includes(key)) { console.error("missing: " + key); process.exit(1); }
}
const m = src.match(/export const inject = \[([^\]]+)\]/);
console.log("  name/inject/apply 齐备");
console.log("  inject = [" + m[1].trim() + "]");
'

echo "=== 3. 状态目录（提示性：bash 沙箱与宿主权限不同，失败不算门禁）==="
node -e '
const {homedir}=require("os"); const {join}=require("path"); const fs=require("fs");
const dir = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "orch");
try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); console.log("  writable: " + dir); }
catch (e) { console.log("  skipped (bash 沙箱默认只能写工作区): " + e.code); }
'

echo "=== check complete ==="
