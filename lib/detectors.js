/**
 * 探测器层：把「本地已经存在的未闭合信号」变成候选（candidate）。
 *
 * 设计原则（实测支撑，不是推想）：
 * - **只接有真信号的**。近 30 天实测：账本未收口 9 条、turn 中断 11 条、
 *   而 `ask_user_question` 未答 0 条（641 个会话里 54 个用过提问，全部答完）——
 *   因为它是阻塞工具，不答就不返回，「未答」在日志里几乎不存在。所以它保留接口但不启用。
 * - 幂等键 = kind|workspace|ref|fingerprint。同一件事状态没变就不会重复产生候选。
 * - 增量：按文件 mtime 游标，只处理变化过的文件。
 *
 * 多帧 zstd 解压方法参照 dsh-project-hub 的 lib/session-scan.js（本机已验证的做法）：
 * 一次 `zstdDecompressSync` 只能拿到第一帧，必须按 frame magic 切帧逐帧解。
 * @module dsh-orch/detectors
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SESSION_FILE_RE = /^session(\.v\d+)?\.jsonl\.zstd$/

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 切出缓冲区里所有 zstd 帧；遇到不认识的字节就停，坏文件不死循环。 */
export function frameRanges(buf) {
  const ranges = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    const start = off
    off += 4
    const descriptor = buf.readUInt8(off)
    off += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) off += 1
    off += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    off += fcsSize
    for (;;) {
      if (off + 3 > buf.length) return ranges
      const header = buf.readUIntLE(off, 3)
      off += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      if (type === 1) off += 1
      else if (type === 2 || type === 0) off += size
      else return ranges
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) return ranges
    ranges.push([start, off])
  }
  return ranges
}

/** 逐帧解压；坏帧跳过（宽容）。 */
export function decompressMultiFrame(buf, { maxFrames = 200000 } = {}) {
  const parts = []
  for (const [start, end] of frameRanges(buf).slice(0, maxFrames)) {
    try { parts.push(zstdDecompressSync(buf.subarray(start, end))) } catch { /* 坏帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return out
}

function detectWorkspaceFromSlug(slug) {
  // 目录名把路径分隔符编码成 -，与文件名里的 - 同形，无法可靠还原；
  // 例：--<user>-Desktop-work-<repo>-- 这类 mangled 目录名只作兜底候选，
  // 还原不可靠（目录名里的 - 与路径分隔符同形），所以只做候选，
  // 真正的工作区以会话 meta.cwd 为准。
  return slug.replace(/^--/, '').replace(/--$/, '')
}

/** 递归找会话日志（有界）。 */
function findSessionFiles(root, { limit = 3000, maxDepth = 4 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > maxDepth) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (SESSION_FILE_RE.test(e.name)) {
        try { out.push({ path: full, mtime: statSync(full).mtimeMs }) } catch { /* 忽略 */ }
      }
      if (out.length >= limit) return
    }
  }
  walk(root, 0)
  return out
}

// ───────────────────────── 探测器 1：账本未收口 ─────────────────────────

/**
 * 账本条目「收了」的判定：**有证据**，或状态显式为 done/dropped。
 * 只有「既没证据、也没标 done/dropped」才算未收口。
 *
 * 这条语义是踩出来的：一开始把「有证据但 status 未显式为 done」也当未收口，
 * 近 30 天算出 124 条假待办（真实只有 9 条）。按 124 条做，router 会天天推噪音。
 */
export function openItemsOf(ledger) {
  return (ledger.items ?? []).filter((item) => {
    const hasEvidence = Array.isArray(item.evidence) && item.evidence.length > 0
    const closed = item.status === 'done' || item.status === 'dropped'
    return !hasEvidence && !closed
  })
}

export const ledgerDetector = {
  id: 'ledger',
  label: '账本未收口',
  /**
   * @param {{lookbackDays:number}} opts
   * @returns {Array<object>} candidates
   */
  scan({ lookbackDays = 30 } = {}) {
    const dir = join(dshHome(), 'completion-ledger')
    if (!existsSync(dir)) return []
    const cutoff = Date.now() - lookbackDays * 86400000
    const out = []
    let files
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return [] }
    for (const name of files) {
      const full = join(dir, name)
      let ledger
      try { ledger = JSON.parse(readFileSync(full, 'utf8')) } catch { continue }
      const updatedAt = ledger.updatedAt || 0
      if (updatedAt < cutoff) continue
      const open = openItemsOf(ledger)
      if (open.length === 0) continue
      const openIds = open.map((i) => i.id).sort().join(',')
      out.push({
        kind: 'ledger',
        ref: String(ledger.sessionId || name.replace(/\.json$/, '')),
        workspace: ledger.cwd || '',
        fingerprint: `rev${ledger.rev ?? 0}:${openIds}`,
        title: String(ledger.taskBrief || '').slice(0, 120) || '(无简报)',
        detail: {
          openCount: open.length,
          total: (ledger.items ?? []).length,
          lastCheck: ledger.lastCheck?.verdict ?? null,
          openItems: open.slice(0, 8).map((i) => ({ id: i.id, text: String(i.text || '').slice(0, 200), status: i.status ?? null })),
        },
      })
    }
    return out
  },
}

// ───────────────────────── 探测器 2：会话被中断 ─────────────────────────

export const abortedDetector = {
  id: 'aborted',
  label: '会话被中断（turn/end = aborted）',
  scan({ lookbackDays = 7, cursorMtime = 0 } = {}) {
    const root = join(dshHome(), 'sessions')
    if (!existsSync(root)) return []
    const cutoff = Math.max(Date.now() - lookbackDays * 86400000, cursorMtime)
    const out = []
    for (const file of findSessionFiles(root)) {
      if (file.mtime <= cutoff) continue
      let events
      try { events = parseLines(decompressMultiFrame(readFileSync(file.path))) } catch { continue }
      const meta = events.find((e) => e.type === 'session')
      if (!meta || meta.parentSession) continue // 只看主会话
      const turnEnds = events.filter((e) => e.type === 'turn/end')
      const last = turnEnds[turnEnds.length - 1]
      if (!last) continue
      if ((last.data?.reason?.kind ?? '') !== 'aborted') continue
      const lastUser = events.filter((e) => e.type === 'user/message').pop()
      const titleEv = events.filter((e) => e.type === 'session/title').pop()
      const text = lastUser?.data?.text ?? lastUser?.data?.message?.content?.map?.((c) => c.text ?? '').join('') ?? ''
      out.push({
        kind: 'aborted',
        ref: String(meta.id || file.path),
        workspace: meta.cwd || detectWorkspaceFromSlug(file.path.split('/sessions/')[1]?.split('/')[0] ?? ''),
        fingerprint: `mtime:${Math.floor(file.mtime / 1000)}`,
        title: String(titleEv?.data?.title || text || '(无标题)').slice(0, 120),
        detail: {
          lastUserText: String(text).slice(0, 400),
          turnCount: turnEnds.length,
          endedAt: new Date(file.mtime).toISOString(),
        },
      })
    }
    return out
  },
}

// ─────────────────── 探测器 3：提问未答（保留，默认不启用） ───────────────────

/**
 * 实测：近 30 天 641 个会话、54 个主会话用过 `ask_user_question`，**未答 0 条**。
 * 原因是它阻塞——不答就不返回。所以这个探测器默认关闭，只保留实现，
 * 以后日志形态若变化（例如出现非阻塞提问）再打开。
 */
export const askPendingDetector = {
  id: 'askPending',
  label: '提问未答（实测 0 命中，默认关闭）',
  enabled: false,
  scan({ lookbackDays = 7, cursorMtime = 0 } = {}) {
    const root = join(dshHome(), 'sessions')
    if (!existsSync(root)) return []
    const cutoff = Math.max(Date.now() - lookbackDays * 86400000, cursorMtime)
    const out = []
    for (const file of findSessionFiles(root)) {
      if (file.mtime <= cutoff) continue
      let events
      try { events = parseLines(decompressMultiFrame(readFileSync(file.path))) } catch { continue }
      const meta = events.find((e) => e.type === 'session')
      if (!meta || meta.parentSession) continue
      const answered = new Set()
      for (const e of events) {
        if (e.type !== 'tool/result') continue
        const cid = e.data?.message?.source?.callId || e.data?.message?.toolCallId || e.data?.toolCallId
        if (cid) answered.add(cid)
      }
      for (const call of events) {
        if (call.type !== 'tool/call' || call.data?.name !== 'ask_user_question') continue
        const cid = call.data?.callId
        if (!cid || answered.has(cid)) continue
        out.push({
          kind: 'askPending',
          ref: String(meta.id || file.path),
          workspace: meta.cwd || '',
          fingerprint: `call:${cid}`,
          title: '有提问未得到回答',
          detail: { arguments: String(call.data?.arguments ?? '').slice(0, 400) },
        })
      }
    }
    return out
  },
}

export const ALL_DETECTORS = [ledgerDetector, abortedDetector, askPendingDetector]

/** 幂等键：同一件事状态没变就不重复产生候选。 */
export function candidateKey(workspace, candidate) {
  return `${candidate.kind}|${workspace}|${candidate.ref}|${candidate.fingerprint}`
}
