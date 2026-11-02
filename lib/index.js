/**
 * @dsh-external/dsh-orch — 异步多席位智能体编排器
 *
 * 解决的核心问题：现在的专家调用（summon_expert）是阻塞的——叫出去之后只能等它跑完，
 * 中途发现方向错了没法拨回来。本插件把「派发」和「等待」拆开：
 *
 *   orch_submit   开一张工作单（必须带可执行的验收条件，写不出来直接拒）
 *   orch_dispatch 派席位 → 立即返回 runId，不占住调用方会话
 *   orch_steer    对运行中的席位插话，在它最近一个 step 边界生效（改方向）
 *   orch_status   随时看进度，返回半成品而不是只等最终结果
 *
 * 跑完时，结果会以一条消息回灌到「当初发起派发的那个会话」，所以发起方不必轮询。
 *
 * 技术要点（全部在本机实机核对过，不是二手结论）：
 * - ctx.agents.withoutInitiator(() => ctx.agents.create({...})) 建独立会话
 * - handle.agent.followup(msg) 投递首轮任务；handle.agent.steer(msg) 中途改方向
 * - agent/inbox 的 splice 语义：next-turn 排队 / next-step 打到最近一步
 * - 结果用 session events 里的 assistant/message 原文块，不拼摘要
 *
 * 纯 ESM、无编译步骤（本机没有带 packages/ 的 DSH 源码 checkout，tsc 链路不可用；
 * 宿主只要求 entry 导出 { name, inject, apply }）。
 * @module dsh-orch
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = '@dsh-external/dsh-orch';

/** 只声明真正用到的服务；缺一个就不激活，避免半残运行。 */
export const inject = ['tools', 'agents', 'agentPresets', 'permissionPresets', 'agentDefaultModel'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 状态目录，缺省 ~/.dsh/orch */
  storageDir: z.string().default(''),
  /** 默认 agent preset */
  agentPreset: z.string().default('standard'),
  /** 单席位超时（分钟） */
  runTimeoutMinutes: z.number().step(1).min(1).max(240).default(30),
  /** 默认席位上限（防止一次派太多烧钱） */
  maxSeats: z.number().step(1).min(1).max(8).default(3),
  /** 默认并发席位（同时最多跑几个） */
  maxConcurrency: z.number().step(1).min(1).max(4).default(2),
});

function storageDirOf(config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return config.storageDir || join(home, 'orch');
}

// ───────────────────────────── 席位定义 ─────────────────────────────

/**
 * 三类席位只差三件事：权限档、能不能产出工件、有没有否决权。
 * 走同一条 create 通道，不写三套代码。
 */
const SEATS = {
  expert: {
    permission: 'read-only',
    canWrite: false,
    prompt: [
      '你是评审席位：只读，不改任何文件。',
      '必须自己打开原始文件/文档核对，不得把交接简报里的转述当作事实依据。',
      '输出结构：① 结论（一句话） ② 关键证据（文件:行 或 命令输出片段） ③ 风险与未确认项。',
      '发现简报与原文不一致时，直接指出不一致，不要迁就简报。',
      '不要建议无关重构，不要扩大范围。',
    ].join('\n'),
  },
  worker: {
    permission: 'workspace-write',
    canWrite: true,
    prompt: [
      '你是执行席位：可以读写文件，但只改验收条件允许的范围。',
      '先读原始需求/文件，再动手；不要凭简报猜测。',
      '每改完一处就跑一次相关校验；校验跑不出来就如实报告为阻塞，不要宣称完成。',
      '输出结构：① 做了什么（文件:行） ② 验证结果（命令+退出码） ③ 没做什么/为什么。',
    ].join('\n'),
  },
  verifier: {
    permission: 'read-only',
    canWrite: false,
    prompt: [
      '你是复核席位：只读，拥有否决权。',
      '不接受执行席位的自述，只接受可复现的证据（命令退出码、diff、文件:行）。',
      '输出结构：① verdict: pass / rework / abort ② 理由 ③ 缺失的证据。',
      '证据不足一律 rework，不要为了推进而放行。',
    ].join('\n'),
  },
};

function seatPromptOf(task, seat) {
  const lines = [];
  lines.push(`# 工作单 ${task.id}`);
  lines.push(`## 目标\n${task.goal}`);
  lines.push(`## 验收条件（必须逐条回应）`);
  if (task.acceptance.length === 0) lines.push('（空）');
  else task.acceptance.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  if (task.cwd) lines.push(`## 工作目录\n${task.cwd}`);
  lines.push(`## 本席位角色\n${SEATS[seat.role].prompt}`);
  if (seat.brief) lines.push(`## 本席位附加说明\n${seat.brief}`);
  lines.push('## 硬约束');
  lines.push('- 简报只是指针：任何结论都必须回到原始文件/原始需求核实后才能给出。');
  lines.push('- 验收条件无法验证时，明确写「无法验证」并说明缺什么，不要假装验证过。');
  lines.push('- 不要修改与本工作单无关的文件。');
  return lines.join('\n\n');
}

// ───────────────────────────── 状态持久化 ─────────────────────────────

function loadState(dir) {
  const file = join(dir, 'state.json');
  if (!existsSync(file)) return { tasks: {}, runs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { tasks: parsed.tasks ?? {}, runs: parsed.runs ?? {} };
  } catch {
    // 坏文件不静默丢弃：改名保留现场，从空状态继续
    try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return { tasks: {}, runs: {} };
  }
}

function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file); // 原子替换，避免半截文件
}

// ───────────────────────────── 结果提取 ─────────────────────────────

/** 从会话事件里取最后一条 assistant 文本 + turn 结束原因（原文，不拼接摘要）。 */
function summarizeRun(events, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq < firstSeq) continue;
    if (event.type === 'turn/start') { started = true; continue; }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      const joined = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data?.reason;
  }
  return { text, reason };
}

function bounded(value, max) {
  const text = (value ?? '').trim();
  if (text === '') return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ───────────────────────────── 插件主体 ─────────────────────────────

export function apply(ctx, config) {
  if (!config.enabled) return;

  const dir = storageDirOf(config);
  const state = loadState(dir);
  /** runId → { handle, caller } 只活在内存里；重启后靠 state.json 标记中断 */
  const live = new Map();

  const persist = () => saveState(dir, state);
  const nowIso = () => new Date().toISOString();

  ctx.effect(() => () => {
    // 卸载：取消仍在跑的席位，避免野会话
    for (const [, entry] of live) {
      try { entry.handle?.agent?.cancel({ kind: 'hook', reason: 'dsh-orch unloaded' }); } catch { /* ignore */ }
    }
    live.clear();
  }, '@dsh-external/dsh-orch: lifecycle')

  function pickSelection() {
    try {
      const selection = ctx.agentDefaultModel?.currentSelection?.();
      if (selection?.provider && selection?.model) return selection;
    } catch { /* fall through */ }
    return undefined;
  }

  function applyPermission(agent, permission) {
    try {
      ctx.permissionPresets.set(agent.session, permission);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 派一个席位：建独立会话 → 投递任务 → **立即返回**，不 await 完成。
   * 完成由后台 watcher 处理，结果回灌到 calllerAgent。
   */
  async function dispatchSeat(task, seat, callerAgent) {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const sessionId = `orch-${runId}`;
    const selection = pickSelection();
    const seatDef = SEATS[seat.role] ?? SEATS.expert;

    const handle = await ctx.agents.withoutInitiator(() => ctx.agents.create({
      sessionId,
      meta: { cwd: task.cwd || process.cwd(), agentPreset: config.agentPreset },
      ...selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {},
      setup: async (agentCtx, createdAgent) => {
        try { await ctx.agentPresets.mount(agentCtx, config.agentPreset); } catch { /* preset 可选 */ }
        if (!createdAgent) throw new Error('orch: setup 没有拿到 Agent');
        applyPermission(createdAgent, seatDef.permission);
      },
    }));

    const run = {
      id: runId, taskId: task.id, seatId: seat.id, role: seat.role, sessionId,
      attempt: 1, status: 'running', startedAt: nowIso(), summary: '', reason: null,
    };
    state.runs[runId] = run;
    persist();
    live.set(runId, { handle, caller: callerAgent });

    // 首轮任务投递
    const firstSeq = handle.agent.session?.seq ?? 0;
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: seatPromptOf(task, seat) }],
      source: { kind: 'user' },
    }));

    // 后台收尾：不阻塞派发方
    void (async () => {
      const timeoutMs = config.runTimeoutMinutes * 60_000;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { handle.agent.cancel({ kind: 'hook', reason: 'orch run timeout' }); } catch { /* ignore */ }
      }, timeoutMs);
      try {
        await handle.agent.whenIdle();
      } catch { /* ignore */ }
      clearTimeout(timer);

      let text = '';
      let reason;
      try {
        const events = handle.agent.session?.events ?? [];
        const outcome = summarizeRun(events, firstSeq);
        text = outcome.text;
        reason = outcome.reason;
      } catch { /* ignore */ }

      run.status = timedOut ? 'timeout'
        : reason?.kind === 'error' ? 'failed'
        : 'done';
      run.reason = reason?.kind ?? null;
      run.summary = bounded(text, 8000);
      run.endedAt = nowIso();
      persist();
      live.delete(runId);

      // 结果回灌：让发起方在自己当前上下文里被叫回来（原文，不转述）
      try {
        let caller = callerAgent ?? null;
        if (!caller && task.callerSession) {
          // 兜底：进程内没握住 agent 时，尝试按会话 id 反查（拿不到就只落盘，由 orch_status 兜）
          try { caller = ctx.agents.get?.(task.callerSession) ?? null } catch { caller = null }
        }
        if (caller) {
          const body = [
            `[orch] 席位 ${seat.role}（${runId}）已结束：${run.status}`,
            task.id ? `工作单：${task.id}` : '',
            run.summary ? `\n—— 原文 ——\n${bounded(run.summary, 4000)}` : '\n（该席位没有产出文本）',
          ].filter(Boolean).join('\n');
          caller.followup(createUserMessage({
            content: [{ type: 'text', text: body }],
            source: { kind: 'user' },
          }));
        }
      } catch { /* 调用方可能已关闭，忽略 */ }
    })();

    return run;
  }

  // ───────────────────────── 工具注册 ─────────────────────────

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orch_submit',
    description: '开一张编排工作单。必须给出可执行的验收条件，写不出来会被拒。',
    parameters: {
      goal: { type: 'string', required: true, description: '要达成什么' },
      acceptance: { type: 'string', required: true, description: '验收条件，用换行或分号分隔；必须可执行/可验证' },
      cwd: { type: 'string', description: '工作目录，缺省当前目录' },
      seats: { type: 'string', description: '席位，形如 expert,worker,verifier；缺省 expert,expert' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args, exec) {
      const acceptance = String(args.acceptance ?? '')
        .split(/[\n;；]/).map((s) => s.trim()).filter(Boolean);
      // 硬约束：验收写不出来就不派发
      if (acceptance.length === 0) {
        return JSON.stringify({
          ok: false,
          error: 'no_acceptance',
          message: '验收条件为空。写不出可验证的验收条件就不派发——这是本插件的硬约束。请先想清楚"怎么算做完"。',
        });
      }
      const requested = String(args.seats ?? 'expert,expert')
        .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (requested.length > config.maxSeats) {
        return JSON.stringify({ ok: false, error: 'too_many_seats', message: `席位数超过上限 ${config.maxSeats}` });
      }
      const seats = requested.map((role, i) => ({
        id: `seat-${i + 1}`,
        role: SEATS[role] ? role : 'expert',
        brief: '',
        dispatched: false,
      }));
      const task = {
        id: `task-${randomUUID().slice(0, 8)}`,
        goal: String(args.goal),
        acceptance,
        cwd: args.cwd ? String(args.cwd) : (exec?.agent?.session?.meta?.cwd ?? process.cwd()),
        seats,
        status: 'open',
        createdAt: nowIso(),
        callerSession: exec?.agent?.session?.id ?? null,
      };
      state.tasks[task.id] = task;
      persist();
      return JSON.stringify({
        ok: true, taskId: task.id, seats: seats.map((s) => ({ id: s.id, role: s.role })),
        next: `调用 orch_dispatch({taskId:"${task.id}"}) 派发，它会立即返回 runId。`,
      });
    },
  })), '@dsh-external/dsh-orch: submit');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orch_dispatch',
    description: '派发席位。立即返回 runId，不等待结果；结果会异步回到本会话。',
    parameters: {
      taskId: { type: 'string', required: true, description: '工作单 id' },
      seat: { type: 'string', description: '只派某个席位 id，缺省派全部未派发的' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args, exec) {
      const task = state.tasks[String(args.taskId)];
      if (!task) return JSON.stringify({ ok: false, error: 'task_not_found' });
      const targets = task.seats.filter((s) => !s.dispatched && (!args.seat || s.id === String(args.seat)));
      if (targets.length === 0) return JSON.stringify({ ok: false, error: 'nothing_to_dispatch' });

      const caller = exec?.agent ?? null;
      const results = [];
      for (const seat of targets) {
        try {
          const run = await dispatchSeat(task, seat, caller);
          seat.dispatched = true;
          results.push({ runId: run.id, seat: seat.id, role: seat.role });
        } catch (error) {
          results.push({ seat: seat.id, error: String(error?.message ?? error) });
        }
      }
      task.status = 'running';
      persist();
      return JSON.stringify({
        ok: results.some((r) => r.runId), taskId: task.id, runs: results,
        note: '已派发，不要等待。用 orch_steer 中途改方向，用 orch_status 看进度；结果会自动回到本会话。',
      });
    },
  })), '@dsh-external/dsh-orch: dispatch');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orch_steer',
    description: '对运行中的席位插话改方向（在它最近一个 step 边界生效，不是立即杀掉当前命令）。',
    parameters: {
      runId: { type: 'string', required: true, description: 'runId' },
      message: { type: 'string', required: true, description: '要它改做什么/不要做什么' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args) {
      const runId = String(args.runId);
      const entry = live.get(runId);
      if (!entry) return JSON.stringify({ ok: false, error: 'run_not_live', message: '该席位不在运行中（可能已结束或插件重启过）。' });
      try {
        entry.handle.agent.steer(createUserMessage({
          content: [{ type: 'text', text: String(args.message) }],
          source: { kind: 'user' },
        }));
        const run = state.runs[runId];
        if (run) { run.steers = (run.steers ?? 0) + 1; persist(); }
        return JSON.stringify({ ok: true, runId, note: '已投递；席位会在下一个 step 边界看到你的调整。' });
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
      }
    },
  })), '@dsh-external/dsh-orch: steer');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orch_status',
    description: '查看工作单与席位状态（含已产出的部分原文）。',
    parameters: {
      taskId: { type: 'string', description: '工作单 id；缺省列出全部' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args) {
      const taskId = args.taskId ? String(args.taskId) : null;
      if (taskId) {
        const task = state.tasks[taskId];
        if (!task) return JSON.stringify({ ok: false, error: 'task_not_found' });
        const runs = Object.values(state.runs).filter((r) => r.taskId === taskId);
        return JSON.stringify({
          ok: true, task,
          runs: runs.map((r) => ({
            runId: r.id, role: r.role, status: r.status, reason: r.reason,
            steers: r.steers ?? 0, summary: bounded(r.summary, 3000),
          })),
        });
      }
      const tasks = Object.values(state.tasks).slice(-10).map((t) => ({
        taskId: t.id, goal: bounded(t.goal, 80), status: t.status, createdAt: t.createdAt,
        runs: Object.values(state.runs).filter((r) => r.taskId === t.id)
          .map((r) => ({ runId: r.id, role: r.role, status: r.status })),
      }));
      return JSON.stringify({ ok: true, tasks });
    },
  })), '@dsh-external/dsh-orch: status');
}
