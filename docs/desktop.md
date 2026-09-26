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

若 Codex 在初始化阶段退出，应检查原始启动错误、Windows 完整性级别及状态目录写入能力。不要自动更改操作系统的安全标签。DSH 的 Codex provider 支持通过 `config.env.CODEX_SQLITE_HOME` 指定独立的 SQLite 状态目录；它不改变原生登录位置，也不能修复操作系统层面的写入限制。
