# DSH 桌面端安装

适用于官方 Desktop `0.1.7-rc.2`。桌面端独占 `desktop` Profile，使用桌面端「插件」页面安装，不使用 CLI 修改这个保留 Profile。

1. 从源码运行 `npm ci`、`npm run check` 和 `npm pack`，得到安装包。
2. 在桌面端「插件」页面安装安装包的绝对路径。插件管理器负责依赖、兼容性检查和 Bundle 激活。
3. 确认官方 Codex Bundle 已安装；使用团队桥接时同时启用官方 Agent Teams Bundle。
4. 备份桌面端 Profile 的 `cordis.patch.yml`，将 [providers.patch.yml](../examples/providers.patch.yml) 中的 Kimi/Grok 条目加入该文件。桌面端 PATH 可能与终端不同，建议将 `command` 设置为实际可执行文件的绝对路径。
5. 启用 Superhook；使用团队任务板时也启用 `superhook-agent-team`。可参照 [agent-team.patch.yml](../examples/agent-team.patch.yml)。不要重复插入已存在的 entry id。
6. 在插件管理页面确认相关条目为运行状态，再从新会话检查工具是否可见。配置热加载未生效时通过插件管理器重新应用；重启前先检查运行中的任务。

## 官方子代理工具入口

Superhook 通过官方 `ctx.subagents` 调用三个 provider。若还需要单独的 Kimi 和 Grok 工具，可在同一 Profile patch 中加入以下条目；Codex 的 `subagent_codex` 沿用官方 Agent Preset 中的配置。

```yaml
- insert:
    - id: superhook-tool-kimi
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: kimi
        toolName: subagent_kimi
        backgroundMode: one-shot
        maxDepth: provider-managed
    - id: superhook-tool-grok
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: grok
        toolName: subagent_grok
        backgroundMode: one-shot
        maxDepth: provider-managed
```

两个工具使用官方 `description`、`prompt` 和 `run_in_background` 参数。Superhook 负责多任务依赖与官方团队任务桥接；单独工具适合直接委派一次任务。

## 模型和权限

Kimi 读取原生默认模型。本机验证的模型别名为 `moonshot-cn/kimi-k2.7-code`，应选择自己的套餐支持的模型，不能仅凭 CLI 登录成功判断模型可用。

Grok 使用原生缓存登录。Codex 使用官方 Bundle 自带的 CLI 与原生登录。Superhook 不保存或复制三个产品的凭据。

示例中的 Kimi/Grok `permission: reject` 会拒绝权限请求。需要允许无人值守的文件修改和命令执行时，部署者可显式设为 `allow`；这会批准相应子代理的权限请求，不等同于继承 DSH 主会话的逐次审批。Claude Code 不在默认允许列表中。

## 验收

先分别运行只返回固定文本的短任务，再验证目标工作区的实际代码任务。检查结果、取消和进程回收；仅看到 provider 已注册不能证明模型调用成功。

团队消息和任务板通过 MCP 工作，与 Codex 原生 `exec_command` / `apply_patch` 是不同通道。团队工具可用不能证明本地文件与命令执行可用。Windows 上可在安装了依赖的源码目录运行下面的无模型探针，检查实际配置的同一份官方 Codex：

```powershell
node scripts/probe-codex-exec.mjs C:/path/to/codex.exe D:/path/to/workspace
```

探针使用官方 `codex sandbox` 和 DSH subprocess 服务，在目标工作区下创建独立临时目录，执行 PowerShell、读取测试文件、写回并核对内容，等进程结束后清理。它不调用模型、不读取凭证、不更改 ACL，也不关闭 sandbox。此入口针对已验证的 Windows Codex `0.153.4`；其他版本先查看 `codex help sandbox`。

如果遇到 `orchestrator_helper_exit_nonzero: setup helper exited with status Some(1)`，应检查官方包清单对应的 `codex-windows-sandbox-setup.exe` 和 `codex-command-runner.exe`，不能只检查 `codex.exe`。一种已验证的原因是辅助程序继承了 Windows Low 完整性标签；错误文本本身不足以确定原因。先比较官方文件版本/哈希和 ACL，再决定修复。更改安全标签前须取得针对具体文件的授权并备份，不递归改目录，不通过关闭 sandbox 绕过问题。参见 [官方 Windows sandbox 排障](https://learn.chatgpt.com/docs/windows/windows-sandbox)。

最后仍须让真实 teammate 使用原生执行工具读取测试输入，通过 `apply_patch` 修改隔离目录内的测试文件，再执行命令验证结果。固定文本回复、MCP 通道、CLI sandbox 和真实原生工具应分别记录验收结果。

若 Codex 在初始化阶段退出，应检查原始启动错误、Windows 完整性级别及状态目录写入能力。不要自动更改操作系统的安全标签。DSH 的 Codex provider 支持通过 `config.env.CODEX_SQLITE_HOME` 指定独立的 SQLite 状态目录；它不改变原生登录位置，也不能修复操作系统层面的写入限制。

# 持续 teammate（0.2.0）

需要让外部 agent 本身进入官方团队名单时，安装或更新 `dsh-superhook-0.2.0.tgz`，启用官方 Agent Teams profile 和 `superhook-teammates` entry，并参照 [原生 teammate 配置](teammates.md) 配置本机可执行文件与项目外的状态目录。Lead 使用 `superhook_spawn_teammate`；后续消息、任务管理及中断沿用官方工具。下文的一次性子代理配置仍然兼容，但不是持续 teammate。
