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

The official generic ACP provider sends initialize and session/new without authenticate. Grok documents an explicit headless cached-token authentication step, so Superhook supplies a separate Grok provider using the official SDK and DSH subprocess owner. Kimi retains the existing generic ACP provider.

The optional Teams bridge claims and completes existing official tasks using revision checks. It retains the caller's official membership, invokes Superhook through the guarded tool registry, and never creates fake external teammate sessions or independent task snapshots. On failure or a concurrent board edit, the task is left for explicit inspection.

## Upgrade checklist

1. Update exact DSH versions together and review public provider, Jobs and Agent Teams declarations.
2. Run `npm run check` and inspect the packed file list.
3. Run keyless CLI handshake probes; do not silently launch login flows.
4. Run bounded real task checks for each configured provider before declaring model-level compatibility.
