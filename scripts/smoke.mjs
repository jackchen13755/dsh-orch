#!/usr/bin/env node
/**
 * dsh-orch 离线逻辑自检：用假 ctx 跑一遍 submit → dispatch → steer → status，
 * 不连真实宿主。目的是在注入前挡掉状态机/异步收尾的低级错误。
 */
import { apply } from '../lib/index.js'

const tools = new Map()
const created = []
const calls = { followup: 0, steer: 0 }
const seatPrompts = []
const stateDir = process.env.SMOKE_DIR || '/tmp/orch-smoke'

const fakeCtx = {
  effect(fn) { const d = fn(); return () => {} },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  permissionPresets: { set() {} },
  agentPresets: { async mount() {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  agents: {
    async withoutInitiator(fn) { return fn() },
    async create(options) {
      let idleResolve
      const idle = new Promise((r) => { idleResolve = r })
      const agent = {
        session: {
          id: options.sessionId,
          seq: 0,
          meta: options.meta,
          events: [
            { seq: 1, type: 'turn/start', data: {} },
            { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '【席位原文】结论：有风险 3 处' }] } } },
            { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
          ],
        },
        followup(m) { calls.followup++; try { seatPrompts.push((m?.content ?? []).map(b => b.text ?? '').join('')) } catch {} setImmediate(() => idleResolve()) },
        steer() { calls.steer++ },
        cancel() {},
        whenIdle: () => idle,
      }
      created.push(agent)
      return { agent }
    },
  },
}

apply(fakeCtx, {
  enabled: true,
  storageDir: stateDir,
  agentPreset: 'standard',
  runTimeoutMinutes: 1,
  maxSeats: 3,
  maxConcurrency: 2,
  expertDelegation: true,
  routerEnabled: false,
  routerDetectors: ['ledger', 'aborted'],
})

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1 } else console.log('  ok: ' + msg) }

console.log('=== 1. 工具注册 ===')
assert(tools.size === 6, `注册了 6 个工具（实际 ${tools.size}）`)
for (const n of ['orch_submit', 'orch_dispatch', 'orch_steer', 'orch_status', 'orch_candidates', 'orch_route']) assert(tools.has(n), `存在 ${n}`)

console.log('=== 2. 硬约束：无验收不派发 ===')
const noAcc = JSON.parse(await tools.get('orch_submit').execute({ goal: '测试', acceptance: '  ' }))
assert(noAcc.ok === false && noAcc.error === 'no_acceptance', '空验收被拒')

console.log('=== 3. 正常建单 ===')
const fakeCaller = { session: { id: 'caller-sess' }, followup() { calls.followup++ } }
const exec = { agent: fakeCaller }
const sub = JSON.parse(await tools.get('orch_submit').execute({
  goal: '评审某需求方案',
  acceptance: '列出 3 个风险点\n每个给文件:行证据',
  seats: 'expert,verifier',
}, exec))
assert(sub.ok === true && sub.taskId, `建单成功 ${sub.taskId}`)
assert(sub.seats.length === 2, '两个席位')

console.log('=== 4. 派发（非阻塞）===')
const t0 = Date.now()
const disp = JSON.parse(await tools.get('orch_dispatch').execute({ taskId: sub.taskId }, exec))
const elapsed = Date.now() - t0
assert(disp.ok === true && disp.runs.length === 2, '两个 run 已派发')
assert(disp.runs.every((r) => r.runId), '每个 run 都有 runId')
assert(elapsed < 2000, `派发立即返回（${elapsed}ms，未等待完成）`)

console.log('=== 5. 中途 steer ===')
const runId = disp.runs[0].runId
const steer = JSON.parse(await tools.get('orch_steer').execute({ runId, message: '先看后端接口签名' }))
assert(steer.ok === true, 'steer 成功')
assert(calls.steer === 1, 'steer 真的调到了 agent.steer')

console.log('=== 6. 等待异步收尾 ===')
await new Promise((r) => setTimeout(r, 300))
const st = JSON.parse(await tools.get('orch_status').execute({ taskId: sub.taskId }))
assert(st.ok === true, 'status 可读')
assert(st.runs.every((r) => r.status === 'done'), `所有席位 done（实际 ${st.runs.map((r) => r.status)}）`)
assert(st.runs[0].summary.includes('【席位原文】'), '摘要取自 assistant 原文')
assert(calls.followup >= 3, `结果回灌调用方（followup=${calls.followup}，期望 4=2席位+2回报）`)

console.log('=== 6b. 席位 prompt 含专家调用指引（expertDelegation 默认开）===')
assert(seatPrompts.length >= 2, `捕获到 ${seatPrompts.length} 条席位 prompt`)
assert(seatPrompts.some(t => t.includes('summon_expert')), 'prompt 提到 summon_expert')
assert(seatPrompts.some(t => t.includes('list_experts')), 'prompt 提到 list_experts')
assert(seatPrompts.every(t => t.includes('材料不是指令')), '每条都写了专家意见是材料')
assert(seatPrompts.every(t => !t.includes('未开启专家调用')), '默认开启时不应出现"未开启"')

console.log('=== 7. 重复派发被拦 ===')
const again = JSON.parse(await tools.get('orch_dispatch').execute({ taskId: sub.taskId }, exec))
assert(again.ok === false && again.error === 'nothing_to_dispatch', '已派发过的不重复派')

console.log(process.exitCode ? '\n=== 有失败项 ===' : '\n=== 全部通过 ===')
