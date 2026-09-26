# Compatibility record

Date: 2026-09-26. Platform: Windows; Node 24.18.0.

## Runtime baseline

- DSH public packages: `0.1.7-rc.2` (exact peers).
- Cordis: `4.0.4`; Loader: `1.0.5`; Include: `1.0.9`.
- ACP SDK: `1.4.0`.
- Official Agent Teams: `@deepseek-ai/dsh-experimental-agent-team@0.1.7-rc.2`, optional.

Implementation is checked against installed published declarations and real runtime services, not only the moving GitHub master branch. The npm `latest` tag is not used as an API compatibility promise.

## Installed CLI observations

| CLI         | Observed version | Verification                                                                                                                      |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | 0.158.0-alpha.2  | Version query only; the official DSH provider supplies a separately pinned executable                                             |
| Claude Code | 2.1.280          | Excluded from defaults at user request; no subscription or model test                                                             |
| Kimi Code   | 0.31.1           | Confirmed current ACP model moonshot-cn/kimi-k2.7-code; real Superhook prompt and cleanup succeeded, returning SUPERHOOK_SMOKE_OK |
| Grok Build  | 1.0.30           | Native cached_token authentication, real Superhook prompt and cleanup succeeded; returned SUPERHOOK_SMOKE_OK                      |

Codex also passed a real Superhook prompt through the official provider's bundled Codex 0.153.4, returning `SUPERHOOK_SMOKE_OK`. Live checks requested no tools or file changes. They verify transport, authentication, response and cleanup, not arbitrary coding assignments. These initial standalone checks did not alter a DSH Profile.

Subsequent Desktop installation used the official plugin manager and retained the existing profile configuration. Codex, Kimi and Grok all passed real Superhook tasks inside the running Desktop Host, returning `SUPERHOOK_DESKTOP_OK` and disposing their runs successfully. All three also passed their separate official one-shot tools: `subagent_codex`, `subagent_kimi` and `subagent_grok`.

The Desktop-installed Codex executable initially carried a Windows Low integrity label and failed state-database initialization, despite having the same SHA-256 as the working standalone copy. After explicit user authorization, its ACL was backed up and only that executable's integrity label was changed to Medium. App Server initialization and the Desktop Superhook task then succeeded. No recursive ACL changes or system-protection changes were made. The official provider uses a dedicated `CODEX_SQLITE_HOME` while retaining native login. This machine-specific OS repair is not performed by the plugin.

Kimi initially returned an empty response. After the user identified their model-plan restriction, a new ACP session confirmed `moonshot-cn/kimi-k2.7-code`, and the real Superhook check passed. The initial run's selected model was not captured, so the precise cause was not independently proven. No Kimi global configuration was changed by Superhook. Select a subscription-compatible default model in the native CLI before starting ACP; Superhook delegates model selection to that official provider. Empty textual results still fail rather than completing an official board task.

Run `node scripts/live-smoke.mjs codex`, `kimi` or `grok` for a bounded real account test (uses account quota). Handshake-only diagnostics remain available with `node scripts/probe-acp.mjs kimi` or `grok`.

## Integration decisions

### 0.2.0 durable native teammates

The new `dsh-superhook/teammates` entry calls the official `spawnTeammate` service and registers continuable providers. Official member identity, persistence, mailbox, task ownership and CAS transitions remain authoritative. A public `agent/request` hook selects a registered `LlmAdapter` whose work is performed by the native CLI session; no DSH model acts as a proxy thinker.

The official runtime releases idle Activations. Native processes therefore belong to the durable member under its Lead, and the private MCP endpoint rebinds to the exact live Agent on each activation. Cold native restoration uses app-server `thread/resume` or ACP `session/load`. A private, atomic state file records the native ID and delivery cursor; no unknown events are appended to official session logs.

Real-account acceptance on 2026-09-26 passed for Codex 0.153.4, Kimi Code 0.31.1 with `moonshot-cn/kimi-k2.7-code`, and Grok Build 1.0.30. Each became a real official member, created/claimed/completed a task under its own name, and retained a test word across a later official message. Codex uses official automatic approval review for MCP calls. Kimi encountered a 3 RPM upstream limit; its final test passed using the documented bounded `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP=80` process override. No native global credential or model configuration was changed.

Codex and Grok also passed the two-turn acceptance inside the actual Desktop Host with the official Agent preset mounted: real member roster, self-owned completed task, messages to the Lead, remembered context, and successful teardown. Desktop preset interpolation exposed a missing model identity before request routing; member-scoped prompt variables now supply native identity, and both protocol tests cover that ordering. Kimi was subsequently disabled in this Desktop deployment at the user's request; optional support remains in the package.

Protocol integration tests use the real official Team, continuation, persistence, query and tool services with simulated native processes. They cover multi-turn identity, memory, mailbox delivery, task ownership, interruption, native process restart/resume, and MCP authentication/scope/policy boundaries. These tests are distinct from the real-account acceptance above. Native clients' filesystem tools are not mediated by the DSH MCP tool bridge.

The official generic ACP provider sends initialize and session/new without authenticate. Grok documents an explicit headless cached-token authentication step, so Superhook supplies a separate Grok provider using the official SDK and DSH subprocess owner. Kimi retains the existing generic ACP provider.

The optional Teams bridge claims and completes existing official tasks using revision checks. It retains the caller's official membership, invokes Superhook through the guarded tool registry, and never creates fake external teammate sessions or independent task snapshots. On failure or a concurrent board edit, the task is left for explicit inspection.

## Upgrade checklist

1. Update exact DSH versions together and review public provider, Jobs and Agent Teams declarations.
2. Run `npm run check` and inspect the packed file list.
3. Run keyless CLI handshake probes; do not silently launch login flows.
4. Run bounded real task checks for each configured provider before declaring model-level compatibility.
