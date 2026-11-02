# dsh-orch

异步多席位智能体编排器（DSH 插件）。

## 它解决什么

现在的专家调用是**阻塞**的：`summon_expert` 叫出去之后，你只能等它跑完。跑到一半发现方向错了，没法拨回来。

dsh-orch 把「派发」和「等待」拆开：

| 工具 | 作用 |
| --- | --- |
| `orch_submit` | 开一张工作单。**验收条件写不出来就直接拒** |
| `orch_dispatch` | 派席位 → **立即返回 runId**，不占住你的会话 |
| `orch_steer` | 对运行中的席位插话，在它**最近一个 step 边界**生效（改方向） |
| `orch_status` | 随时看进度，返回**已产出的部分原文** |

席位跑完后，结果以一条消息**回灌到当初发起派发的会话**，所以你不用轮询，也不会错过。

## 三个语义必须分清

- `steer`：下一个思考步就看到你的新方向，但**正在跑的命令会先跑完**
- `followup`：排队到下一轮，不打断
- 想立刻叫停：本版尚未提供单独的中断工具，排在下个版本

## 席位

| 席位 | 权限 | 说明 |
| --- | --- | --- |
| `expert` | read-only | 只读评审，必须回读原文，不接受转述 |
| `worker` | workspace-write | 执行，只改验收允许的范围 |
| `verifier` | read-only | 复核，有否决权，证据不足一律 rework |

## 两条硬约束（写死在派发逻辑里）

1. **简报只是指针**：任何结论必须回到原始文件核实后才能给出，不得把转述当事实。
2. **验收不可执行就不派发**：`orch_submit` 的 acceptance 为空会直接返回 `no_acceptance` 并拒绝建单。

## 用起来

```
orch_submit({ goal: "评审需求 6080 的方案", acceptance: "列出 3 个风险点\n每个风险点给出文件:行证据", seats: "expert,expert" })
orch_dispatch({ taskId: "task-xxxxxxxx" })      // 立即返回 runId
orch_steer({ runId: "run-xxxxxxxx", message: "先看后端接口签名，别急着看 UI" })
orch_status({ taskId: "task-xxxxxxxx" })        // 看进度和半成品
```

## 安装

```sh
dsh plugin --profile desktop add github:jackchen13755/dsh-orch
```

装完会跑 `postinstall`（`scripts/heal-env.sh`）：把 `@deepseek-ai/dsh-tools` / `dsh-llm` / `schemastery` 链回**宿主那一份实例**。

这一步不是可选优化，原因写在脚本头部：peer 包不随插件安装，缺了 ESM 解析失败，宿主里表现为 `[no-fiber]`；而必须是宿主同实例，因为 schemastery 的 schema 由宿主按实例校验。反过来 `npm i` 会把不在依赖树里的手链软链当 extraneous 剪掉，所以每次装完都要自愈。

宿主探测顺序：`DSH_HOST_NODE_MODULES` 显式指定 > 含完整 `@deepseek-ai/dsh` 的安装（mtime 新者优先）> 其余含 peer 的目录。

## 状态与恢复

状态落在 `~/.dsh/orch/state.json`（原子写）。席位会话 id 形如 `orch-run-xxxxxxxx`。

**已知限制（v0.1）**：插件重启后，运行中的席位不会自动续跑——`state.json` 里会留下 `running` 记录，需要 `orch_status` 人工确认后重新派发。续跑（sessionId 复用 + 授权重校验）排在下一版。

## 设计出处

架构参考 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的三个内核（工作单生命周期独立于会话、先落库再做事、每席独立会话与目录），**但不照搬**它的 GitHub/飞书事件源、审批矩阵与 `danger-full-access` worker：

- 事件源换成「你一句话 + 验收条件」，因为单人场景没有外部 issue 流
- 不做审批屏 / 角色 DSL / DAG 编排，单人没有第二主体
- 权限从紧：评审与复核席位 read-only，只有执行席位可写
