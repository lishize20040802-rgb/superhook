# Superhook development

- Implement a DSH function plugin with named `name`, `inject`, `Config`, and `apply` exports. No default export.
- Use public DSH services; do not import provider internals or modify DSH's agent loop.
- Keep provider transport and authentication owned by official providers. Do not read or copy credentials.
- Pin the supported DSH prerelease. Update the compatibility document and Loader tests with dependency upgrades.
- Use strict TypeScript, ESM, `.ts` relative source imports, and types-only `src/types.ts`.
- Every accepted run must be cancelled and disposed before releasing its workspace reservation. Cleanup failures must remain visible.
- Validate model input before starting any child. Never retry a task that may have written files automatically.
- Keep tests under `tests/`. Cover the real Loader, registry execution, disposal, cancellation, and dependency failures.
- Run `npm run check` and `npm pack --dry-run` after implementation. Document limitations honestly.
