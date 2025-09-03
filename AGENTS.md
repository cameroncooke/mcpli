# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source. Entry is `src/mcpli.ts`; daemon code in `src/daemon/` (runtime, IPC, wrapper); config in `src/config.ts`; utilities in `src/utils/`.
- `tests/`: Vitest specs split by `unit/`, `integration/`, and `e2e/`. Test helpers in `tests/test-helper.ts`.
- `dist/`: Build output (`mcpli.js`, `daemon/wrapper.js`). Do not edit manually.
- `scripts/`: Maintenance scripts (`release.sh`, `test-regression.sh`).
- Sample MCP servers for local testing: `weather-server.js`, `test-server.js`, `complex-test-server.js`.

## Build, Test, and Development Commands
- `npm run build`: Bundle with tsup (targets Node 22). Outputs to `dist/` and sets execute bits.
- `npm run dev`: Convenience rebuild (same as build) for iterative work.
- `npm run typecheck`: TypeScript checks without emit.
- `npm run lint` | `npm run lint:fix`: Lint (ESLint) and optionally fix.
- `npm test`: Run all tests (Vitest). Variants: `test:unit`, `test:integration`, `test:e2e`, `coverage`.
- Local CLI example: `./dist/mcpli.js --help -- node weather-server.js`.

## Coding Style & Naming Conventions
- Formatting: Prettier (2‑space indent, single quotes, semicolons, trailing commas, width 100). Check with `npm run format:check`; write with `npm run format`.
- Linting: ESLint + TypeScript ESLint. In `src/`, avoid `any`, prefer explicit return types, and do not import `*.js` from TS (`no-restricted-imports`).
- File names: use `kebab-case` for files, `PascalCase` for types/classes, `camelCase` for variables/functions.

## Testing Guidelines
- Framework: Vitest with Node environment; coverage via V8 (`text`, `html`, `lcov`).
- Location/patterns: `tests/**/**/*.test.ts`. Keep fast unit tests under `tests/unit` and heavier flows under `integration`/`e2e`.
- Isolation: use helpers in `tests/test-helper.ts` (temp dirs, daemon polling) for stable daemon tests.

## Commit & Pull Request Guidelines
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Example: `feat: add daemon status subcommand`.
- PRs: include a clear description, linked issues (`closes #123`), test instructions, and update `CHANGELOG.md` when user-facing.
- Pre‑merge checklist: `npm run build`, `npm run typecheck`, `npm run lint`, and passing tests.

## Security & Configuration Tips
- Runtime: Node ≥ 22 (see `package.json engines`).
- Daemon logs: inspect `.mcpli/daemon.log`; avoid committing `.mcpli/` artifacts.
- When passing env to servers, prefer simple `KEY=value` pairs; unsafe keys (e.g., `__proto__`) are rejected by design.

