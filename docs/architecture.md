# MCPLI Architecture

MCPLI turns any MCP server into a first‑class CLI tool with a fast, seamless experience. It supports both stateless one‑off execution and long‑lived daemon processes that auto‑start when a server command is provided and are reused across invocations. This document explains the architecture and how each part works together with an emphasis on environment‑aware daemon isolation and current function signatures.

Contents:
- [1) Overall Architecture](#1-overall-architecture)
- [2) Configuration System](#2-configuration-system)
  - [Configuration Priority (highest to lowest):](#configuration-priority-highest-to-lowest)
  - [Available Configuration:](#available-configuration)
  - [Environment Variables:](#environment-variables)
  - [Configuration Functions:](#configuration-functions)
  - [Usage Examples:](#usage-examples)
- [3) CommandSpec and Environment Handling](#3-commandspec-and-environment-handling)
- [4) Parameter Parsing and Validation](#4-parameter-parsing-and-validation)
  - [Parameter Types Supported:](#parameter-types-supported)
  - [Parsing Logic (parseParams in src/mcpli.ts):](#parsing-logic-parseparams-in-srcmcplits)
  - [Critical Bug Fix:](#critical-bug-fix)
  - [Validation Features:](#validation-features)
- [5) Daemon Architecture with Env‑Aware Isolation](#5-daemon-architecture-with-envaware-isolation)
- [6) Timeout Management](#6-timeout-management)
  - [1. Daemon Inactivity Timeout](#1-daemon-inactivity-timeout)
  - [2. IPC Connection Timeout](#2-ipc-connection-timeout)
  - [3. CLI Operation Timeout](#3-cli-operation-timeout)
  - [Timeout Conversion and Units:](#timeout-conversion-and-units)
  - [Timeout Reset Mechanism:](#timeout-reset-mechanism)
- [7) MCP Forwarding via Daemon Wrapper](#7-mcp-forwarding-via-daemon-wrapper)
- [8) Process Lifecycle](#8-process-lifecycle)
- [9) IPC Communication](#9-ipc-communication)
- [10) File System Structure and State Persistence](#10-file-system-structure-and-state-persistence)
  - [Directory Structure:](#directory-structure)
  - [Lock File Format (DaemonInfo):](#lock-file-format-daemoninfo)
  - [State Persistence Features:](#state-persistence-features)
  - [State Management Functions:](#state-management-functions)
  - [Cross-Platform Considerations:](#cross-platform-considerations)
  - [Legacy Compatibility:](#legacy-compatibility)
- [11) Automatic Startup and Fallbacks](#11-automatic-startup-and-fallbacks)
- [12) Help System and Tool Discovery](#12-help-system-and-tool-discovery)
  - [Help Generation Strategy:](#help-generation-strategy)
  - [Help Types:](#help-types)
  - [Help Prioritization:](#help-prioritization)
  - [Context-Aware Examples:](#context-aware-examples)
  - [Help Implementation:](#help-implementation)
- [13) Error Handling and Recovery](#13-error-handling-and-recovery)
  - [Error Categories:](#error-categories)
  - [Recovery Strategies:](#recovery-strategies)
  - [Error Message Quality:](#error-message-quality)
- [14) Cross-Platform Considerations](#14-cross-platform-considerations)
  - [Path Normalization:](#path-normalization)
  - [Environment Variable Handling:](#environment-variable-handling)
  - [Process Management:](#process-management)
  - [File System:](#file-system)
- [15) Key Components and Code References](#15-key-components-and-code-references)
- [Example: End‑to‑End Sequence (Env‑Aware Daemon ID)](#example-endtoend-sequence-envaware-daemon-id)
- [Operational Considerations](#operational-considerations)
- [Appendix: Core APIs (selected signatures)](#appendix-core-apis-selected-signatures)



## 1) Overall Architecture

MCPLI provides a CLI that:
- Discovers available MCP tools from a given MCP server.
- Parses CLI arguments into schema‑validated parameters (using the server’s tool inputSchema).
- Executes tools either via a long‑lived daemon (preferred for speed) or statelessly (direct subprocess) when needed.

Two runtime modes:
- Stateless mode: Directly starts an MCP server process via stdio, calls tools, then exits.
- Daemon mode: Starts a persistent wrapper that keeps a long‑lived MCP client connection; MCPLI communicates with it via IPC for fast, repeated calls.

Entry point:
- src/mcpli.ts is the CLI entry point that parses arguments (including env variables for the server process), manages daemon subcommands, discovers tools, and executes calls.

Important:
- For normal execution, the server command is required after --. MCPLI will not auto‑select or auto‑start a daemon without an explicit server command. Daemon subcommands can operate without the server command, and help flows may query an already running daemon, but regular tool execution requires -- <command> [args...].


## 2) Configuration System

MCPLI uses a centralized configuration system (src/config.ts) that provides environment variable support and sensible defaults for all timeout values.

### Configuration Priority (highest to lowest):
1. **CLI arguments** (--timeout=300)
2. **Environment variables** (MCPLI_DEFAULT_TIMEOUT=600)
3. **Built-in defaults** (1800 seconds)

### Available Configuration:
```ts
interface MCPLIConfig {
  defaultTimeoutSeconds: number;        // 1800 (30 minutes)
  defaultCliTimeoutSeconds: number;     // 30 seconds
  defaultIpcTimeoutMs: number;          // 10000ms (10 seconds)
}
```

### Environment Variables:
- **`MCPLI_DEFAULT_TIMEOUT`**: Daemon inactivity timeout in seconds
  - Purpose: How long daemons stay alive when idle
  - Default: 1800 (30 minutes)
  - Used by: Daemon wrapper inactivity timer

- **`MCPLI_CLI_TIMEOUT`**: CLI operation timeout in seconds
  - Purpose: Timeout for daemon startup, status checks, cleanup operations
  - Default: 30 seconds
  - Used by: General CLI operations (not currently implemented)

- **`MCPLI_IPC_TIMEOUT`**: IPC connection timeout in milliseconds
  - Purpose: How long to wait for daemon responses during tool calls
  - Default: 10000ms (10 seconds)
  - Used by: sendIPCRequest(), testIPCConnection()

### Configuration Functions:
```ts
// Get current configuration (respects environment variables)
export function getConfig(): MCPLIConfig

// Resolve daemon timeout with CLI override priority
export function resolveDaemonTimeout(cliTimeout?: number): number

// Get daemon timeout in milliseconds for internal use
export function getDaemonTimeoutMs(cliTimeout?: number): number
```

### Usage Examples:
```bash
# Set via environment variable
export MCPLI_DEFAULT_TIMEOUT=3600  # 1 hour

# Override with CLI argument
mcpli get-weather --timeout=300 --location "NYC" -- node server.js

# Help shows current default (respects env vars)
mcpli --help -- node server.js
# Shows: --timeout=<seconds> Set daemon inactivity timeout (default: 3600)
```

## 3) CommandSpec and Environment Handling

MCPLI supports embedding environment variables for the MCP server directly in the command specification after --:

Grammar:
- KEY=VALUE tokens precede the server command.
- Multiple KEY=VALUE tokens are supported; they are collected into an env object for the server process.
- Example:
  ```
  mcpli get-weather -- OPENAI_API_KEY=sk-xyz node weather-server.js --port 3000
  ```

Parsing:
- parseCommandSpec(tokens) in src/mcpli.ts:
  - Collects KEY=VALUE tokens into env until the first non‑env token.
  - The next token is the command, and the remaining tokens are args.
  - Throws if no command is present after --.

Type:
```ts
type CommandSpec = {
  env: Record<string, string>;
  command: string;
  args: string[];
};
```

Behavior:
- The env in CommandSpec is used in:
  - Daemon ID generation (see Section 3).
  - Launching the MCP server (daemon wrapper and stateless fallback inherit process.env and merge CommandSpec env).
- Only the env provided in CommandSpec participates in daemon ID hashing. Ambient process.env does not affect daemon identity.


## 4) Parameter Parsing and Validation

MCPLI provides comprehensive JSON Schema-aware parameter parsing that handles all MCP data types correctly.

### Parameter Types Supported:
- **Strings**: `--location "San Francisco"`
- **Numbers**: `--count 42`, `--rating -123.456` (supports negative numbers)
- **Integers**: `--port 3000`
- **Booleans**: `--enabled` (flag form) or `--debug false` (explicit value)
- **Arrays**: `--tags='["web","api","cli"]'` (JSON format)
- **Objects**: `--config='{"timeout":5000,"retries":3}'` (JSON format)
- **Null**: `--empty null`

### Parsing Logic (parseParams in src/mcpli.ts):

1. **Phase 1 - Argument Collection**:
   - Processes `--key value` and `--key=value` formats
   - Handles boolean flags (valueless arguments)
   - Special handling for negative numbers (fixed bug where `-122.4194` was parsed as `true`)

2. **Phase 2 - Schema-Aware Conversion**:
   ```ts
   // Uses tool's inputSchema to determine expected types
   const propSchema = schema[key];

   if (propSchema.type === 'boolean') {
     // Handle flag form or explicit true/false strings
   } else if (propSchema.type === 'number' || propSchema.type === 'integer') {
     // Numeric conversion with validation
   } else if (propSchema.type === 'array' || propSchema.type === 'object') {
     // JSON parsing with error handling
   }
   ```

3. **Error Handling**:
   - Clear error messages for type mismatches
   - JSON parsing errors with context
   - Required parameter validation
   - Unknown parameter handling (best-effort parsing)

### Critical Bug Fix:
Fixed negative number parsing where `!nextArg.startsWith('-')` rejected valid negative numbers:
```ts
// Before (buggy)
if (!nextArg.startsWith('-')) {

// After (fixed)
if (!nextArg.startsWith('-') || !isNaN(Number(nextArg))) {
```

### Validation Features:
- **Required parameters**: Enforced based on inputSchema.required
- **Type coercion**: Automatic conversion from strings to target types
- **Default values**: Applied from schema.default when parameters omitted
- **Best-effort parsing**: Unknown parameters attempted as JSON, fallback to string

## 5) Daemon Architecture with Env‑Aware Isolation

MCPLI supports multiple concurrent daemons per directory, and daemon identity is now environment‑aware. Each daemon is identified by the normalized command, normalized args, and a normalized subset of environment variables explicitly provided via CommandSpec.

Daemon identity:
- Env‑aware normalization and hashing in src/daemon/lock.ts:
  - normalizeCommand(command, args)
    - Resolves absolute path, normalizes separators.
    - On Windows: convert backslashes to forward slashes and lowercase the path.
    - Args normalized similarly (slashes normalized on Windows).
  - normalizeEnv(env)
    - Ensures string values.
    - On Windows: uppercases env keys to avoid case‑sensitivity inconsistency.
    - Sorts keys for stable hashing.
  - generateDaemonIdWithEnv(command, args, env)
    - Creates a JSON array: [normalizedCommand, ...normalizedArgs, { env: normalizedEnv }]
    - Computes SHA‑256 hex digest and uses the first 8 characters as the daemon ID.

Implications:
- Different env sets (e.g., different API keys or flags) produce different daemon IDs and thus separate daemons.
- This allows safe reuse of a daemon only when command, args, and effective server env match.

Per‑daemon files:
- Lock file: .mcpli/daemon-{id}.lock
- Socket file: .mcpli/daemon-{id}.sock

Relevant code:
- Env‑aware identity and locking:
  - generateDaemonIdWithEnv(), normalizeCommand(), normalizeEnv(): src/daemon/lock.ts
  - acquireDaemonLockWithEnv(): src/daemon/lock.ts
- Legacy (non‑env) helpers still exist (generateDaemonId(), acquireDaemonLock()), but daemon operations use the env‑aware variants.


## 6) Timeout Management

MCPLI implements a sophisticated timeout system with three distinct timeout categories, each serving different purposes:

### 1. Daemon Inactivity Timeout
**Purpose**: Automatic resource cleanup - shuts down idle daemons
**Default**: 1800 seconds (30 minutes)
**Configurable via**:
- CLI: `--timeout=3600`
- Environment: `MCPLI_DEFAULT_TIMEOUT=3600`
- Config: `resolveDaemonTimeout()`

**Behavior**:
- Timer resets on every IPC request (ping, listTools, callTool)
- Implemented in daemon wrapper (src/daemon/wrapper.js)
- Graceful shutdown with cleanup on timeout

```js
// In wrapper.js
resetInactivityTimer() {
  if (this.inactivityTimeout) {
    clearTimeout(this.inactivityTimeout);
  }

  this.inactivityTimeout = setTimeout(() => {
    this.gracefulShutdown();
  }, this.timeoutMs);
}
```

### 2. IPC Connection Timeout
**Purpose**: Detect unresponsive daemons during tool calls
**Default**: 10000ms (10 seconds)
**Configurable via**: `MCPLI_IPC_TIMEOUT=5000`
**Used by**: sendIPCRequest(), testIPCConnection()

**Behavior**:
- Applied to each individual IPC request
- Fast failure detection for crashed/hung daemons
- Triggers fallback to stateless mode

### 3. CLI Operation Timeout
**Purpose**: General CLI operation timeout (planned)
**Default**: 30 seconds
**Configurable via**: `MCPLI_CLI_TIMEOUT=60`
**Status**: Defined but not currently implemented

### Timeout Conversion and Units:
- **User input**: Always in seconds (user-friendly)
- **Internal storage**: Milliseconds for setTimeout() compatibility
- **Automatic conversion**: Via getDaemonTimeoutMs() function

```ts
// Centralized conversion
export function getDaemonTimeoutMs(cliTimeout?: number): number {
  return resolveDaemonTimeout(cliTimeout) * 1000;
}
```

### Timeout Reset Mechanism:
Every daemon request resets the inactivity timer:
```js
async handleIPCRequest(request) {
  this.resetInactivityTimer();  // First thing - reset timer

  // Handle request...
}
```

## 7) MCP Forwarding via Daemon Wrapper

The daemon process is a detached Node process (wrapper) that maintains a persistent MCP client connected to the target MCP server. It exposes a local IPC interface to MCPLI for tool listing and execution.

Wrapper configuration:
- The spawner sets environment variables for the wrapper process:
  - MCPLI_SOCKET_PATH: per‑daemon socket path
  - MCPLI_CWD: working directory
  - MCPLI_DEBUG: "1" or "0"
  - MCPLI_LOGS: "1" or "0"
  - MCPLI_TIMEOUT: inactivity timeout in ms
  - MCPLI_COMMAND: child command to execute (the MCP server)
  - MCPLI_ARGS: JSON‑encoded array of child args
  - MCPLI_DAEMON_ID: precomputed daemon ID
- The wrapper:
  - Acquires an env‑aware lock via acquireDaemonLockWithEnv(command, args, env, cwd, daemonId).
    - Writes a DaemonInfo JSON with env included.
  - Creates a long‑lived MCP client using StdioClientTransport with:
    - command, args
    - env: merged from process.env plus the env provided in CommandSpec
    - stderr: inherit when debug/logs enabled; otherwise ignore
  - Creates IPC server on MCPLI_SOCKET_PATH.
  - Handles IPC:
    - ping → 'pong'
    - listTools → mcpClient.listTools()
    - callTool → mcpClient.callTool({ name, arguments })


## 8) Process Lifecycle

A typical invocation flows as follows:

1) CLI parse and routing (src/mcpli.ts)
- parseArgs(argv) splits CLI arguments into:
  - Global flags (e.g., --debug, --raw, --timeout=ms)
  - User tool arguments (before --)
  - CommandSpec (after --) parsed by parseCommandSpec:
    - env: KEY=VALUE tokens
    - command: executable
    - args: arguments for the MCP server

2) Tool discovery (src/mcpli.ts)
- discoverToolsEx(command, args, env, options):
  - Prefers daemon via DaemonClient.
  - If command is provided, DaemonClient auto‑starts the daemon on demand.
  - If daemon communication fails and command exists, falls back to stateless execution (direct stdio) with env applied.
  - If no command is provided (daemon‑only query scenarios like some help flows), MCPLI does not auto‑start any daemon.

3) Tool selection and parameter parsing
- findTool(userArgs, tools): First non‑option token selects the tool (supports hyphen/underscore variations and normalized names).
- parseParams(userArgs, selectedTool, toolName):
  - Schema‑aware conversion of string flags to boolean/number/integer/array/object/null types.
  - Parses JSON for array/object; handles boolean flags and "true"/"false".
  - Best‑effort parsing for unknown keys; clear validation errors on mismatches.

4) Execution
- Daemon path: DaemonClient.callTool({ name, arguments }) → IPC → wrapper → mcpClient.callTool(...)
- Stateless path: Directly instantiates StdioClientTransport, connects a Client, calls tool, then closes.

5) Output formatting
- Raw mode (--raw) prints the full MCP response JSON.
- Default mode extracts result.content, parses JSON from text payloads when possible, and prints a user‑friendly output.


## 9) IPC Communication

MCPLI uses a simple newline‑delimited JSON protocol over a Unix domain socket (or platform equivalent).

Message shapes:
- Request:
  ```json
  { "id": "123-abc", "method": "listTools" }
  { "id": "456-def", "method": "callTool", "params": { "name": "tool_name", "arguments": { "k": "v" } } }
  { "id": "ping-id", "method": "ping" }
  ```
- Response:
  ```json
  { "id": "123-abc", "result": { "tools": [ ... ] } }
  { "id": "456-def", "result": { "content": [ ... ] } }
  { "id": "ping-id", "result": "pong" }
  // or on error:
  { "id": "456-def", "error": "Message" }
  ```

Server side:
- createIPCServer(socketPath, handler) in src/daemon/ipc.ts:
  - Removes any existing socket file, listens on socketPath.
  - Buffers data, splits on newline, parses JSON, calls handler, sends JSON newline‑terminated response.
  - close() cleans up the socket on shutdown.

Client side:
- sendIPCRequest(socketPath, request, timeoutMs) in src/daemon/ipc.ts:
  - Connects, writes JSON + \n, waits for a single newline‑terminated response.
  - Enforces timeout and returns result or throws errors.
- testIPCConnection(daemonInfo) does a quick ping with a short timeout.

Supported methods:
- 'ping' | 'listTools' | 'callTool'


## 10) File System Structure and State Persistence

MCPLI maintains persistent state across invocations using a structured file system approach in the `.mcpli/` directory.

### Directory Structure:
```
.mcpli/
├── daemon-{hash}.lock     # Process metadata and state
├── daemon-{hash}.sock     # Unix domain socket for IPC
├── daemon.lock           # Legacy single-daemon lock
├── daemon.sock           # Legacy single-daemon socket
└── daemon.log            # Optional external logging
```

### Lock File Format (DaemonInfo):
```ts
interface DaemonInfo {
  pid: number;                           // Process ID
  socket: string;                        // Absolute path to socket file
  command: string;                       // MCP server command
  args: string[];                        // MCP server arguments
  started: string;                       // ISO timestamp when started
  lastAccess: string;                    // ISO timestamp of last request
  cwd: string;                          // Working directory
  env?: Record<string, string>;         // Environment variables for server
}
```

### State Persistence Features:

1. **Last Access Tracking**:
   - Updated on every successful IPC request
   - Persisted to disk immediately via updateLastAccess()
   - Used for daemon status reporting and stale detection

2. **Process Validation**:
   - PID validation using process.kill(pid, 0)
   - Automatic cleanup of stale entries
   - Cross-platform process detection

3. **Environment Persistence**:
   - Server environment variables stored in lock file
   - Used for daemon identity verification
   - Enables proper daemon reuse validation

4. **Atomic Operations**:
   - Lock file operations use proper-lockfile for safety
   - Prevents race conditions during daemon startup
   - Automatic cleanup on process termination

### State Management Functions:
```ts
// Core state operations
export async function getDaemonInfo(cwd?: string, daemonId?: string): Promise<DaemonInfo | null>
export async function updateLastAccess(cwd = process.cwd(), daemonId?: string): Promise<void>
export async function isDaemonRunning(cwd?: string, daemonId?: string): Promise<boolean>

// Bulk operations
export async function listAllDaemons(cwd: string): Promise<string[]>
export async function cleanupAllStaleDaemons(cwd: string): Promise<void>
```

### Cross-Platform Considerations:
- **Socket paths**: Unix domain sockets on Unix, named pipes on Windows
- **Path normalization**: Forward slashes, case handling
- **Process detection**: Platform-specific PID validation
- **File locking**: Cross-platform proper-lockfile usage

### Legacy Compatibility:
Supports legacy single-daemon paths (daemon.lock/daemon.sock) for backward compatibility and scenarios where no specific daemon ID is available.

Per‑directory state lives under .mcpli:

- Directory: .mcpli
- Per‑daemon lock files: .mcpli/daemon-{id}.lock
  - JSON file with DaemonInfo:
    ```json
    {
      "pid": 12345,
      "socket": "/abs/path/.mcpli/daemon-ab12cd34.sock",
      "command": "node",
      "args": ["weather-server.js"],
      "started": "2024-01-01T00:00:00.000Z",
      "lastAccess": "2024-01-01T00:05:00.000Z",
      "cwd": "/abs/path",
      "env": {
        "OPENAI_API_KEY": "sk-xxx",
        "MY_FLAG": "1"
      }
    }
    ```
- Per‑daemon socket files: .mcpli/daemon-{id}.sock
- Optional log file: .mcpli/daemon.log (if implemented externally)

Management utilities:
- getLockFilePath(), getSocketPath(): src/daemon/lock.ts
- getDaemonInfo(), updateLastAccess(), isDaemonRunning(): src/daemon/lock.ts
- listAllDaemons(), cleanupAllStaleDaemons(): src/daemon/lock.ts

Legacy paths:
- Helpers accept undefined daemonId and fall back to legacy single‑daemon paths (daemon.lock/daemon.sock). This is primarily for compatibility and limited scenarios (e.g., querying when no command is supplied). Regular execution should always specify -- <command>.


## 11) Automatic Startup and Fallbacks

Daemon auto‑start:
- DaemonClient auto‑starts only when a server command is provided (after --).
- Without a server command, MCPLI does not auto‑start any daemon and will not attempt to guess; it may only query an already running daemon (legacy default path) in limited flows such as help.

Fallback to stateless:
- If daemon IPC calls fail and a server command exists, DaemonClient falls back to stateless execution:
  ```ts
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined)
  ) as Record<string, string>;
  const transport = new StdioClientTransport({
    command: this.command,
    args: this.args,
    env: this.options.env ? { ...safeEnv, ...this.options.env } : undefined,
    stderr: this.options.logs ? 'inherit' : 'ignore'
  });
  ```
- The stateless path merges process.env (filtered) with the CommandSpec env for correct behavior matching the daemon path.


## 12) Help System and Tool Discovery

MCPLI provides a comprehensive help system that dynamically generates documentation from MCP server metadata.

### Help Generation Strategy:
1. **Dynamic tool discovery**: Always queries the actual MCP server
2. **Schema-driven help**: Uses inputSchema for parameter documentation
3. **Context-aware examples**: Shows actual command used, including env vars
4. **Centralized formatting**: Single buildCommandString() function for consistency

### Help Types:

1. **General Help** (`mcpli --help -- server`):
   - Usage patterns
   - Global options with current defaults (respects env vars)
   - Available tools list with descriptions
   - Tool help instructions
   - Daemon management commands
   - Examples using the exact command provided

2. **Tool-Specific Help** (`mcpli tool --help -- server`):
   - Tool name and description
   - Parameter list with types, requirements, defaults
   - Usage examples with actual command

### Help Prioritization:
Help sections are ordered by user priority:
1. Usage and Global Options
2. **Available Tools** (primary user interest)
3. Tool Help instructions
4. Daemon Commands (advanced users)
5. Examples

### Context-Aware Examples:
All help examples use the actual command provided:
```bash
# User runs:
mcpli --help -- DEBUG=true node weather-server.js --port 3000

# Examples show:
mcpli get-weather --help -- DEBUG=true node weather-server.js --port 3000
mcpli get-weather --option value -- DEBUG=true node weather-server.js --port 3000
```

### Help Implementation:
```ts
// Centralized command string building
function buildCommandString(actualCommand?: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}): string

// Help functions
function printHelp(tools: any[], specificTool?: any, actualCommand?: CommandInfo)
function printToolHelp(tool: any, actualCommand?: CommandInfo)
```

## 13) Error Handling and Recovery

MCPLI implements comprehensive error handling with graceful degradation and recovery mechanisms.

### Error Categories:

1. **Daemon Connection Errors**:
   - IPC timeout → Fallback to stateless
   - Socket connection failure → Auto-restart attempt
   - Process crash detection → Automatic cleanup

2. **Parameter Validation Errors**:
   - Type mismatch → Clear error message with expected type
   - JSON parsing failure → Context and suggested fix
   - Required parameter missing → List of required params

3. **MCP Server Errors**:
   - Server startup failure → Detailed error with command
   - Tool execution error → Forward server error message
   - Server crash → Detect and restart daemon

### Recovery Strategies:

1. **Fallback to Stateless**:
   ```ts
   // Automatic fallback when daemon fails
   if (this.options.fallbackToStateless) {
     return this.fallbackCallTool(params);
   }
   ```

2. **Automatic Cleanup**:
   - Stale process detection and cleanup
   - Socket file removal on daemon crash
   - Lock file cleanup on process termination

3. **Graceful Degradation**:
   - Help works even with server connection failure
   - Daemon commands work independently of MCP server health
   - Clear error messages guide user troubleshooting

### Error Message Quality:
- **Specific and actionable**: "Invalid coordinates format. Use 'latitude,longitude'"
- **Context-aware**: Include tool name and argument in error messages
- **Recovery suggestions**: Suggest --debug for detailed diagnostics
- **Command-specific**: Show exact command that failed

## 14) Cross-Platform Considerations

MCPLI is designed for cross-platform compatibility with specific handling for platform differences.

### Path Normalization:
- **Windows**: Convert backslashes to forward slashes, lowercase paths
- **Case sensitivity**: Handle case-insensitive filesystems
- **Path resolution**: Use absolute paths for daemon identity

```ts
function normalizeCommand(command: string, args?: string[]): {
  command: string;
  args: string[];
} {
  // Resolve to absolute path
  const resolvedCommand = path.resolve(command);

  // Platform-specific normalization
  const normalizedCommand = process.platform === 'win32'
    ? resolvedCommand.toLowerCase().replace(/\\/g, '/')
    : resolvedCommand;

  // Normalize args similarly
  const normalizedArgs = args?.map(arg => /* normalize arg */) || [];

  return { command: normalizedCommand, args: normalizedArgs };
}
```

### Environment Variable Handling:
- **Windows**: Uppercase environment variable names for consistency
- **Case sensitivity**: Handle case-insensitive env vars on Windows
- **Key sorting**: Ensure stable hashing across platforms

### Process Management:
- **PID validation**: Platform-specific process detection
- **Socket creation**: Unix domain sockets vs named pipes
- **Process spawning**: Detached process creation with platform-specific options

### File System:
- **Socket paths**: Handle platform-specific socket limitations
- **File locking**: Use proper-lockfile for cross-platform file locking
- **Directory creation**: Recursive directory creation with proper permissions

## 15) Key Components and Code References

High‑level CLI:
- src/mcpli.ts
  - parseArgs(argv): Parses global flags, identifies CommandSpec after -- using parseCommandSpec, and routes to regular or daemon subcommands.
  - parseCommandSpec(tokens): Extracts env (KEY=VALUE tokens), command, and args.
  - discoverToolsEx(command, args, env, options): Prefers daemon, falls back to direct stdio when command is provided.
  - findTool(userArgs, tools), parseParams(userArgs, selectedTool, toolName)
  - extractContent(result), printHelp()/printToolHelp()
  - main(): Orchestrates end‑to‑end flow, including daemon subcommands.

Daemon management and client:
- src/daemon/client.ts
  - DaemonClient: IPC caller with env‑aware daemon IDs, auto‑start when command exists, and fallback to stateless.
    - constructor(command, args, options?: DaemonClientOptions)
    - listTools(), callTool(params), ping()
  - withDaemonClient(): Helper for single‑operation flows.

Locking and daemon identity:
- src/daemon/lock.ts
  - normalizeCommand(), normalizeEnv()
  - generateDaemonIdWithEnv(command, args, env)
  - acquireDaemonLockWithEnv(command, args, env, cwd?, daemonId?)
  - getDaemonInfo(), updateLastAccess(), isDaemonRunning()
  - listAllDaemons(), cleanupAllStaleDaemons()
  - Legacy: generateDaemonId(), acquireDaemonLock()

IPC layer:
- src/daemon/ipc.ts
  - createIPCServer(), sendIPCRequest(), testIPCConnection(), generateRequestId()

Process spawner and testing harness:
- src/daemon/spawn.ts
  - startDaemon(command, args, options?: DaemonOptions):
    - Computes daemonId using generateDaemonIdWithEnv when not provided.
    - Launches wrapper with MCPLI_* env and waits for readiness via ping.
  - waitForDaemonReady(socketPath, timeoutMs)
  - InProcessDaemon: In‑process daemon used for development/testing.

Daemon wrapper:
- src/daemon/wrapper.js
  - MCPLIDaemon: Manages MCP client connection, IPC, inactivity timer, graceful shutdown, and env‑aware lock lifecycle (via acquireDaemonLockWithEnv).


## Example: End‑to‑End Sequence (Env‑Aware Daemon ID)

1) User runs:
   ```
   mcpli get-weather -- OPENAI_API_KEY=sk-live node weather-server.js
   ```
2) CLI parses args and discovers tools:
   - parseCommandSpec() extracts env = { OPENAI_API_KEY: "sk-live" }, command = "node", args = ["weather-server.js"].
   - discoverToolsEx(...) creates DaemonClient with env and autoStart: true.
3) DaemonClient computes daemonId = generateDaemonIdWithEnv(command, args, env).
4) DaemonClient tries callDaemon('listTools'):
   - Not running → startDaemon(...) spawns wrapper with daemonId.
   - Wrapper acquires lock via acquireDaemonLockWithEnv and writes lock with env metadata.
   - Wrapper creates MCP client (stdio) with merged env and starts IPC server.
5) CLI finds selected tool and parseParams(...) builds arguments.
6) CLI invokes DaemonClient.callTool({ name, arguments }):
   - IPC → wrapper → mcpClient.callTool(...) → server executes.
7) Wrapper responds over IPC; CLI formats the output and prints it.
8) Later calls with the same command/args/env reuse the same daemon for instant startup.
9) Calls with different env (e.g., OPENAI_API_KEY=sk-test) create/use a distinct daemon due to the env‑aware ID.


## Operational Considerations

- Server command requirement:
  - For normal execution you must provide the server command after --. MCPLI does not auto‑select or auto‑start a daemon without it.
- Inactivity timeout:
  - MCPLI_TIMEOUT (ms) or options.timeout controls auto‑shutdown (default 30 minutes).
  - Wrapper resets timer on every IPC request; on timeout it shuts down gracefully.
- Logging:
  - When debug/logs are enabled, the MCP server’s stderr is inherited to aid troubleshooting.
- Cleanup:
  - Stale locks/sockets are removed when processes are gone (cleanupAllStaleDaemons).
- Cross‑platform normalization:
  - Command path normalization and Windows‑specific rules (path lowercasing, slash normalization; env keys uppercased on Windows) ensure stable daemon IDs across platforms.


## Appendix: Core APIs (selected signatures)

- src/mcpli.ts
  ```ts
  type CommandSpec = {
    env: Record<string, string>;
    command: string;
    args: string[];
  };

  function parseCommandSpec(tokens: string[]): CommandSpec;
  async function discoverToolsEx(
    command: string,
    args: string[],
    env: Record<string, string>,
    options: GlobalOptions
  ): Promise<{
    tools: any[];
    daemonClient?: any;
    client?: any;
    isDaemon: boolean;
    close: () => Promise<void>;
  }>;
  ```

- src/daemon/lock.ts
  ```ts
  export function normalizeCommand(
    command: string,
    args?: string[]
  ): { command: string; args: string[] };

  export function generateDaemonIdWithEnv(
    command: string,
    args?: string[],
    env?: Record<string, string>
  ): string;

  export async function acquireDaemonLockWithEnv(
    command: string,
    args: string[],
    env?: Record<string, string>,
    cwd?: string,
    daemonId?: string
  ): Promise<DaemonLock>;
  ```

- src/daemon/client.ts
  ```ts
  export interface DaemonClientOptions {
    logs?: boolean;
    debug?: boolean;
    cwd?: string;
    timeout?: number;
    daemonId?: string;
    env?: Record<string, string>;
    autoStart?: boolean;
    fallbackToStateless?: boolean;
  }

  export class DaemonClient {
    constructor(command: string, args: string[], options?: DaemonClientOptions);
    async listTools(): Promise<any>;
    async callTool(params: { name: string; arguments: any }): Promise<any>;
    async ping(): Promise<boolean>;
  }

  export async function withDaemonClient<T>(
    command: string,
    args: string[],
    options: DaemonClientOptions,
    operation: (client: DaemonClient) => Promise<T>
  ): Promise<T>;
  ```

- src/daemon/spawn.ts
  ```ts
  export interface DaemonOptions {
    logs?: boolean;
    debug?: boolean;
    cwd?: string;
    timeout?: number;
    daemonId?: string;
    env?: Record<string, string>;
  }

  export interface DaemonProcess {
    lock: DaemonLock;
    close: () => Promise<void>;
  }

  export async function startDaemon(
    command: string,
    args: string[],
    options?: DaemonOptions
  ): Promise<DaemonProcess>;
  ```

- src/daemon/ipc.ts
  ```ts
  export interface IPCRequest { id: string; method: 'listTools' | 'callTool' | 'ping'; params?: any; }
  export async function createIPCServer(socketPath: string, handler: (req: IPCRequest) => Promise<any>): Promise<IPCServer>;
  export async function sendIPCRequest(socketPath: string, request: IPCRequest, timeoutMs?: number): Promise<any>;
  export async function testIPCConnection(info: { socket: string }): Promise<boolean>;
  export function generateRequestId(): string;
  ```

Examples (env handling):
- Different env → different daemons:
  ```
  # Daemon A (live key)
  mcpli get-weather -- OPENAI_API_KEY=sk-live node weather-server.js

  # Daemon B (test key) — distinct daemonId due to env difference
  mcpli get-weather -- OPENAI_API_KEY=sk-test node weather-server.js
  ```

- Stateless fallback preserves env:
  ```
  mcpli get-weather -- OPENAI_API_KEY=sk-live node weather-server.js
  # If daemon IPC fails, MCPLI starts the server directly with the same env.
  ```