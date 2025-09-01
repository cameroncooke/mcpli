# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

MCPLI is a TypeScript CLI tool that transforms stdio-based MCP (Model Context Protocol) servers into first-class command-line tools. It maintains persistent daemon processes for fast, stateful tool execution.

## Key Architecture Principles

### Command Structure
- **Always requires explicit server command**: `mcpli <tool> [options] -- <mcp-server-command> [args...]`
- **No default daemon selection**: Every invocation must specify the MCP server command after `--`
- **Environment-aware daemon isolation**: Different server commands, arguments, or environment variables create separate daemons

### Daemon Identity and Environment Variables
**CRITICAL**: Environment variables work differently for daemon identity vs MCP server execution:

- **Daemon Identity**: Only considers environment variables specified AFTER the `--` as part of the server command
  - `mcpli tool -- ENV_VAR=value node server.js` → daemon ID includes ENV_VAR
  - `ENV_VAR=value mcpli tool -- node server.js` → daemon ID does NOT include ENV_VAR (same daemon as without ENV_VAR)

- **MCP Server Environment**: Environment variables before `--` affect mcpli itself, not the daemon identity
  - Shell environment where mcpli runs should not influence daemon uniqueness
  - Only explicit environment in the server command affects daemon hashing

### File Structure
- **Entry point**: `src/mcpli.ts` - CLI argument parsing and tool execution
- **Daemon system**: `src/daemon/` - Persistent process management
  - `client.ts` - Daemon client for IPC communication
  - `spawn.ts` - Daemon process spawning and management
  - `wrapper.ts` - In-process daemon wrapper
  - `lock.ts` - Daemon identity, locking, and state management
  - `ipc.ts` - Unix socket IPC communication
- **Test servers**: `weather-server.js`, `test-server.js`, `complex-test-server.js`

## Development Commands

### Build and Development
```bash
npm run build          # Build with tsup
npm run dev            # Alias for build
npm run lint           # ESLint check
npm run lint:fix       # ESLint fix
npm run typecheck      # TypeScript check
```

### Testing
- **Manual testing**: Use `docs/testing.md` for comprehensive daemon system tests
- **Test servers available**:
  - `weather-server.js` - Full-featured with API calls (get-weather, get-forecast)
  - `test-server.js` - Simple/reliable (echo, fail, delay tools)
  - `complex-test-server.js` - JSON Schema validation testing (test_all_types)

### Running from Source
```bash
# During development (from repo root)
node dist/mcpli.js <tool> [options] -- <server-command>

# Or with ts-node
npx ts-node src/mcpli.ts <tool> [options] -- <server-command>
```

## Code Quality Standards

### TypeScript Configuration
- **Strict mode enabled** with `no-explicit-any`, `no-unsafe-*` rules
- **ESM modules only** (`"type": "module"` in package.json)
- **Node.js 18+ required** for native fetch and ESM support

### Linting Rules
- Uses `@typescript-eslint` with strict rules
- Prettier for code formatting
- No explicit `any` types allowed
- Unsafe TypeScript operations prohibited

## Architecture Details

### Daemon Lifecycle
1. **Daemon Creation**: Each unique `command + args + env` combination gets its own daemon with SHA-256 hash ID
2. **IPC Communication**: Unix domain sockets (`.mcpli/daemon-{hash}.sock`)
3. **Lifecycle Management**: macOS launchd handles daemon supervision and socket activation
4. **Automatic Cleanup**: Configurable inactivity timeout (default: 30 minutes)

### Configuration System
- **Environment Variables**: `MCPLI_DEFAULT_TIMEOUT`, `MCPLI_CLI_TIMEOUT`, `MCPLI_IPC_TIMEOUT`
- **Priority**: CLI args > environment variables > built-in defaults
- **Timeout Units**: Seconds for CLI (user-facing), milliseconds for internal IPC

### Error Handling
- **Robust Error Handling**: Provides clear error messages when daemon operations fail
- **Process Recovery**: Automatic cleanup of stale processes and socket files
- **User-Friendly Messages**: Clear error reporting with actionable guidance

## Important Implementation Notes

### Environment Variable Behavior
The `deriveIdentityEnv()` function in `src/daemon/lock.ts` determines which environment variables affect daemon identity. Currently includes all `process.env` except `MCPLI_*` variables, but this may need adjustment based on the architectural requirement that only server command environment should matter.

### Command Parsing
The argument parsing in `src/mcpli.ts` handles the complex `-- <server-command>` syntax and environment variable extraction. Pay attention to the split between mcpli arguments and server command arguments.

### macOS Implementation Details
- **Path Normalization**: Commands and paths are normalized for consistent daemon IDs
- **Socket Permissions**: Unix domain sockets use restrictive permissions (0600)
- **Process Management**: Handles detached processes and cleanup

## Contributing Guidelines

### Making Changes
1. **Follow TypeScript strict mode** - no `any` types, handle all error cases
2. **Test daemon behavior** using the manual test suite in `docs/testing.md`
3. **Verify environment isolation** - ensure different env vars create separate daemons as expected
4. **Run all checks**: `npm run lint && npm run typecheck && npm run build`

### Testing Strategy
- **Use provided test servers** instead of external dependencies
- **Test daemon lifecycle** including creation, communication, and cleanup
- **Verify environment variable behavior** matches architectural expectations
- **Test daemon mode** for all tool operations

This codebase emphasizes reliability, performance, and clean separation between CLI interface and MCP server execution while maintaining backward compatibility and robust error handling.