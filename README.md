# Superhook

DSH 的多智能体协作插件，当前版本 `0.2.0`。让 Codex、Kimi Code 与 Grok Build 成为官方 Agent Teams 的持续 teammate，也保留一次性任务计划和 Jobs 集成。Claude Code 暂不启用。

兼容基线：**DSH 0.1.7-rc.2、Cordis 4.0.4、Node.js 24+**。DSH 仍在快速迭代，不声明兼容其他预发布版本；不要通过版本豁免跳过接口检查。

## 能力

| 工具                       | 用途                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `superhook_agents`         | 列出配置允许的智能体以及官方 provider 注册状态；不代表已经登录           |
| `superhook_run`            | 执行有依赖关系的任务计划，传递依赖结果并汇总；可交给官方 Jobs 在后台运行 |
| `superhook_team_task`      | 可选：认领官方 Agent Teams 任务，委派给外部智能体，成功后完成原任务      |
| `superhook_spawn_teammate` | 创建由原生外部客户端驱动的真正官方 teammate，保留独立会话                |

`superhook_run` 的同一计划串行执行。依赖失败时跳过下游，独立任务可以继续；取消停止后续任务。每个子任务释放进程后才开始下一个。不会自动重试、提交代码、回滚文件或合并分支。持续 teammate 则遵循官方团队的并发和任务协作规则。

## 对齐官方团队

要让外部 agent 本身成为团队成员，启用 `dsh-superhook/teammates`，使用 [持续 teammate 配置与说明](docs/teammates.md)。Lead 调用 `superhook_spawn_teammate` 选择 `codex`、`kimi` 或 `grok`；创建由官方 `agentTeams.spawnTeammate()` 完成。

成员会出现在官方 `list_agents` 和团队界面中，能够主动调用官方 `send_message`、`team_task_*`，任务的 owner 就是该外部 teammate。Lead 使用官方 `interrupt_agent` 和 `wait_agent`。DSH 的持久会话、邮箱和成员生命周期保持不变；Superhook 通过公共模型适配接口将执行接到原生 Codex App Server 或 ACP 会话。

DSH 空闲时会释放成员的运行实例；Superhook 在同一 Lead 生命周期内保留外部会话，唤醒后重新绑定当前成员。插件或 Host 重启后的恢复使用原生 `thread/resume` / `session/load`，客户端不支持时明确失败，不偷偷新建失忆会话。

例如对 DSH 说：

> 使用官方智能体团队，通过 Superhook 创建 codex 实现者和 grok 审查者。建立任务板，划分文件范围，让成员通过官方消息沟通；后续消息继续发给已有成员，不要重新创建。

Kimi 为可选支持，需要可用的原生登录和模型权限；没有订阅时不必配置或启用。

### 一次性任务桥接

已有的 `superhook_team_task` 仍适用于把单项任务交给一次性外部执行器：

1. 用官方工具创建任务及依赖。
2. 成员读取任务的 `id`、`revision` 和准备状态。
3. 调用 `superhook_team_task`，传入 `task_id`、`expected_revision`、`provider`。
4. 桥接通过 `ctx.agentTeams.updateTask()` 原子认领，调用受官方工具策略保护的 `superhook_run`，成功后以原认领版本完成任务。

任务所有者仍是调用它的官方成员。Codex 等外部进程不伪装成持续 teammate。失败、取消、权限拒绝或并发编辑冲突后，已认领任务保持 `in_progress`，由成员检查改动后用官方工具释放或调整。完成仅表示外部任务正常结束，验收要求应写入任务描述；需要独立审查时另建一个有依赖的官方审查任务。

`superhook_run` 也可单独使用；它的计划和结果是一次调用的数据，不另建持久化任务板。需要真正成员时使用 `superhook_spawn_teammate`，不要用一次性委派代替。

## 安装与启用

桌面端用户请先阅读 [桌面端安装与子代理配置](docs/desktop.md)。

先确认目标 DSH 版本。以下命令针对 CLI 的 `web` Profile；官方 Desktop 的保留 Profile 应由 Desktop 自己的插件管理界面管理。

```powershell
npm ci
npm run check
npm pack

dsh --version
dsh plugin --profile web add D:/dsh-superhook/dsh-superhook-0.2.0.tgz
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.1.7-rc.2
```

Bundle 安装默认添加禁用的工具入口，避免把能力自动授予所有 Agent。启用方式二选一：

- **按 Agent 授权，推荐**：在复制的官方 Agent Preset 的 `cordis.yml` 中加入 `name: dsh-superhook`；需要官方任务板桥接时再加入 `name: dsh-superhook/agent-team`。保留该 Preset 原有的官方工具与服务。
- **显式 Host 全局启用**：使用下面的 `enable.patch.yml`。这会使所有能看到全局工具的 Agent 访问 Superhook。

```powershell
dsh --profile web --patch D:/dsh-superhook/examples/providers.patch.yml --patch D:/dsh-superhook/examples/enable.patch.yml
```

`providers.patch.yml` 加载 Kimi ACP provider 和 Superhook Grok provider；Codex 由其官方 Bundle 加载。不要重复注册同名 provider。CLI 不在 PATH 时，将 patch 的 `command` 改为对应可执行文件绝对路径。

启用官方 Agent Teams Bundle 后，可将最后一个 patch 换成 `examples/agent-team.patch.yml`，同时开启任务板桥接。插件不自动启用实验性团队服务，也不修改官方源码、全局登录配置或用户现有 Profile。

```yaml
# 加到复制的 Agent Preset 中，或按需组成自己的工具层。
- id: superhook
  name: dsh-superhook
  config:
    providers: [codex, kimi, grok]
    maxTasks: 8
    taskTimeoutMs: 600000
    maxPlanBytes: 65536
    maxResultBytes: 131072
- id: superhook-agent-team
  name: dsh-superhook/agent-team
```

## 智能体接入

| 智能体     | 实现                                  | 登录与权限                                                                                    |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Codex      | 官方 `dsh-subagent-codex`，App Server | 使用官方包配套的 CLI 和原生登录/配置；不保证与 PATH 内 CLI 版本相同                           |
| Kimi Code  | 官方 `dsh-subagent-acp`，`kimi acp`   | 先在 CLI 登录；示例默认拒绝权限询问                                                           |
| Grok Build | `dsh-superhook/grok`，官方 ACP SDK    | `initialize → authenticate(cached_token) → session/new → session/prompt`；先执行 `grok login` |

DSH 的通用 ACP provider 在此基线没有显式 `authenticate` 步骤，因此 Grok 使用独立的小型 provider，仍通过 `ctx.subagents` 注册、`ctx.subprocess` 启动和回收进程，以及官方结果/清理辅助函数发布生命周期。它不读取 token 文件、不代办登录、不调用 xAI 模型 HTTP API。仅支持 Grok 缓存登录；API-key 模式不在第一版范围内。

Grok 配置可设置 `command`、`args`、`providerName`、`permission`、`startupTimeoutMs`、`disposeGraceMs`、`maxOutputBytes`。默认 `permission: reject`；显式配置 `allow` 才接受当前会话的 `allow_once` 请求。Kimi 示例同样使用 `reject`。拒绝权限可能使需要写文件或执行命令的任务无法完成；权限由部署者配置，不交给模型自行扩大。

## 使用

先让 DSH 调用 `superhook_agents` 检查 provider，再描述需要完成的工作。独立计划示例见 [examples/review-plan.json](examples/review-plan.json)。它以三个智能体串行完成只读分析与审查。Kimi 使用原生配置中的默认模型，本机已验证 `moonshot-cn/kimi-k2.7-code`；请使用自己套餐支持的模型。

```json
{
  "task_id": "task-1",
  "expected_revision": 1,
  "provider": "codex"
}
```

上面是 `superhook_team_task` 的参数。任务内容来自官方任务板，不需要重复粘贴。

`superhook_run` 设置 `run_in_background: true` 会返回官方 `jobId`，继续使用官方 `job_list`、`job_output` 和 `job_kill`。后台任务需要当前 Agent 能访问官方 Job 控制工具；发布之后，取消启动它的那次工具调用不会取消 Job。Job 取消、所有者卸载或 Superhook 卸载会停止并清理工作。

每个任务必须提供唯一 `id`、`provider`、完整 `prompt` 和 `dependsOn` 数组。输入整体、依赖关系、provider 允许列表及注册情况在启动前验证。依赖答案只交给显式依赖它的任务。结果超限会裁剪任务答案并标记 `outputTruncated`；包含依赖结果的任务提示词超限会明确失败。

## 验证与开发

```powershell
npm run check
npm pack --dry-run
# 可选开发诊断：只握手与创建空会话，不发送提示词。
node scripts/probe-acp.mjs kimi
node scripts/probe-acp.mjs grok
```

测试通过真实官方 YAML Loader、工具注册表、Agent、Subagent、Jobs 和持久化 Agent Teams 服务运行，只替换外部模型/CLI。Grok 测试运行独立的模拟 ACP 子进程，覆盖认证顺序、会话隔离、取消、拒绝、异常退出和输出上限。构建检查用普通 Node 加载编译后的 ESM 插件。

本机验证记录见 [docs/compatibility.md](docs/compatibility.md)。Codex、Kimi 2.7 Code 和 Grok 均已通过真实短任务。Superhook 将空结果判为失败并阻止依赖任务及官方任务板的自动完成。真实代码修改协作尚未验证。

Claude Code 不在默认 provider 列表中，也未进行模型调用测试。以后需要时可安装匹配版本的官方 Bundle，再显式加入 `providers` 列表。

## Model Experience

模型看到允许的 provider 列表、任务执行工具及结构化结果。桥接入口另外暴露一个官方任务执行工具。外部智能体收到任务文本、明确依赖的结果和自身运行时配置，不继承父会话历史。

每个任务单独消耗其智能体账户额度和上下文。父会话增加工具参数、完成报告或官方 Job 通知；子智能体中间推理与工具轨迹不汇入父上下文。工具结果按官方流水线追加到日志，缓存复用受各自运行时控制。

## Known Limitations and Deferred Work

- 同一计划串行执行；第一版没有并行 worktree、跨进程调度、自动合并、持久化计划恢复或断点续跑。
- 工作区互斥只覆盖同一 Host 进程内通过 Superhook 启动的计划，按规范化目录区分；不约束用户、其他工具、嵌套目录或其他 Host。官方 `writeScopes` 仍是提示，不是文件锁。
- 官方外部 provider 是一次性委派，不能直接成为官方 Teams 的可持续成员，也不支持 `send_message` 继续外部会话。官方团队成员可委派给它们。
- 官方 Codex/Claude/ACP provider 的可用能力、登录要求和权限限制仍然适用。第一版不支持每次任务动态切换模型。
- 取消和超时依赖 provider 遵守官方取消/清理约定。清理失败后，同一进程中该工作区停止接受新计划；检查遗留进程后重启 Host。崩溃后不得假定部分文件改动已撤回。
- 官方 Agent Teams 为可选实验性依赖；桥接入口与基础工具分开加载。
- 无独立 `./invariant`：报告是调用返回值，持久化任务板直接使用官方服务，不维护第二份需要交叉校验的状态投影。

## 官方依据

- [DSH 插件规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/AGENTS.md)
- [Subagent 服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [Agent Teams 服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md)
- [Grok ACP 与认证](https://docs.x.ai/build/cli/headless-scripting)

MIT License。第三方组件保留各自许可证。
