# 原生外部 teammate

适用版本：Superhook 0.2.0，DSH 0.1.7-rc.2。

## 启用

先启用官方 `@deepseek-ai/dsh-experimental-agent-team-profile` bundle，再启用 `superhook-teammates` entry。参见 [配置示例](../examples/teammates.patch.yml)。Desktop 必须通过自身插件管理器安装或更新 bundle。

`stateDirectory` 必须是 Host 上的绝对路径，放在项目之外。每个 provider 配置原生可执行文件、参数、协议和权限。`name` 为小写标识符；注册的持续 provider 名为 `superhook-<name>`，与原来的 `codex` / `kimi` / `grok` 一次性 provider 并存。

Lead 调用：

```json
{
  "provider": "codex",
  "name": "implementer",
  "description": "实现分配的功能并与审查者沟通",
  "prompt": "读取官方任务板，认领就绪任务，完成后更新状态并给 lead 发消息。"
}
```

工具名是 `superhook_spawn_teammate`。返回的成员由官方管理；后续直接使用官方 `send_message`、`list_agents`、`wait_agent`、`interrupt_agent` 和任务板工具。外部成员通过 MCP 使用同一套官方工具，并以自己的成员身份执行。其他成员也可以把消息发给它。

## 生命周期与恢复

- 每个成员有独立的 DSH Session 和原生会话；原生进程可跨 DSH 的空闲释放与再次唤醒保留。
- 官方模型适配接口驱动原生回合，不修改 DSH 循环，不让另一个 DSH 模型代替外部 agent 思考。
- 官方成员身份、任务 owner、revision、邮箱、依赖和团队界面全部由官方服务管理。
- 中断转发到原生协议；未及时停止时终止受管理进程。被强制终止的进程不会自动重新执行刚才的任务。
- 默认最多保留 8 个原生会话，单回合 10 分钟；可配置 `maxSessions`、`turnTimeoutMs`、`startupTimeoutMs`、`disposeGraceMs`、`maxOutputBytes`。
- 插件卸载和 Lead 释放会关闭外部进程及私有 MCP 服务。下一次恢复依赖客户端的 `thread/resume` 或 ACP `loadSession`，不支持恢复会明确报错。
- Native 状态文件仅保存原生会话 ID、配置摘要及已递交消息 ID，不保存账户凭证。递交前记录消息 ID，避免崩溃后自动重放可能已经产生写入的任务。

## 权限与客户端设置

MCP 只监听 `127.0.0.1`，每个成员使用独立随机令牌。令牌不对模型公开，服务只在该成员回合内接受团队工具调用；每次调用都经过官方工具 registry 和策略守卫。它不提供 shell、任意 DSH 工具或自选成员身份。

原生客户端自己的文件与命令权限独立配置。`permission: reject` 是默认值；ACP 拒绝请求批准的操作，Codex 使用只读 sandbox。Codex 的 `review` 使用官方 `on-request` 和 `auto_review`，可能拒绝未获授权的操作。`allow` 仅用于部署者明确授权的可信本机环境：ACP 选择 `allow_once`，Codex 使用 `danger-full-access`。不要把官方任务的 `writeScopes` 当作系统级文件锁。

Kimi 可通过 CLI 参数固定 `--model moonshot-cn/kimi-k2.7-code`。遇到低 RPM 限流，可在该 provider 的 `env` 中设置官方 `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`（例如 `80`）。这只调整原生客户端对当前模型请求的有限重试，不重跑整个 Superhook 任务；总时限仍由 `turnTimeoutMs` 控制。参见 [Kimi 官方环境变量说明](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html)。

## 当前边界

此版面向同一台电脑上的原生客户端，提供文本消息和 fresh 成员创建；不支持跨机器 MCP 回连、图片输入或把 Lead 的完整历史 fork 到原生会话。消息在外部当前回合结束后由 DSH 接续处理；不承诺每次原生工具调用都能立刻插入新的队友消息。DSH 中显示的是回合结束后的文本，原生内部工具流尚未逐项映射到 DSH UI。

当前官方成员视图的 `model` 字段取自创建选项，可能仍显示继承的 Lead 模型；`provider: superhook-codex` / `superhook-grok` 才标识外部执行路由。实际模型由原生 CLI 与该 provider 的配置选择。系统提示中的模型变量已按成员单独设置，不继承 Lead 的模型标签。

官方成员可并发编辑同一工作目录，应通过任务 owner、依赖和不重叠的写范围协调。外部执行不使用一次性 `superhook_run` 的串行工作区锁。辅助模型调用（例如 DSH 会话标题与压缩）不能使用 `superhook-native` 路由；原生客户端管理自己的上下文。

空输出被视为异常，即使已发生部分团队工具操作，也不会由桥接补写任务完成或自动重跑。特别是部分 Kimi ACP 版本会将原生模型错误呈现为 `end_turn` 加空输出；查看原生诊断和任务板后再决定如何继续。

## 公开仓库与隐私

代码不读取、复制或提交 Codex/Kimi/Grok 的登录文件或 API Key。原生客户端自行使用本机登录状态。仓库仅提供通用配置示例；本机部署配置、日志、诊断、运行状态和安装包放在忽略目录或项目外。npm 包采用显式文件清单，不包含 `.local`、`.env` 或客户端配置目录。GitHub 仓库所有者和 Git 提交作者属于公开仓库元数据，不是客户端登录凭证。
