# Root Cause Analysis: MCPLI IPC Timeout Hierarchy Issue

## Executive Summary

After fixing the MCP SDK's 60-second tool timeout limitation, a new issue emerged: **the IPC timeout (5 minutes) is shorter than the tool execution timeout (10 minutes)**, causing the IPC connection to disconnect while MCP servers are still legitimately processing long-running tools.

## Problem Statement

- **Symptom**: `Error: IPC request timeout after 300000ms` occurs at exactly 5 minutes
- **Impact**: Long-running operations fail even though tool timeout was increased to 10 minutes
- **Root Cause**: Inverted timeout hierarchy where transport layer times out before application layer

## Timeout Architecture

### Current Timeout Chain
```
User CLI Request
    ↓
MCPLI CLI Layer
    ↓
IPC Transport Layer (5 min timeout) ← BREAKS HERE
    ↓
MCPLI Daemon (wrapper.ts)
    ↓
MCP SDK Client (10 min tool timeout)
    ↓
MCP Server (xcodebuildmcp)
    ↓
Actual Tool Operation (xcodebuild)
```

### Timeout Configuration (Current - INCORRECT)
| Layer | Timeout | Purpose | Config Key |
|-------|---------|---------|------------|
| Daemon Inactivity | 30 minutes | Idle daemon shutdown | `MCPLI_DEFAULT_TIMEOUT` |
| Tool Execution | 10 minutes | MCP tool operations | `MCPLI_TOOL_TIMEOUT_MS` |
| **IPC Transport** | **5 minutes** | Socket communication | `MCPLI_IPC_TIMEOUT` |
| CLI Operations | 30 seconds | (Unused) | `MCPLI_CLI_TIMEOUT` |

## The Problem Explained

The timeout hierarchy is **inverted**. The IPC transport layer (lower level) has a shorter timeout than the application layer (higher level):

```
Tool Timeout:    |------------------------| 10 minutes
IPC Timeout:     |------------|              5 minutes
                             ^ IPC disconnects here
                               while tool is still running
```

## Evidence

### Test Results
1. **Initial state**: Tool timed out at 60 seconds (MCP SDK default)
2. **After tool timeout fix**: IPC times out at exactly 5 minutes (300,000ms)
3. **Error message**: "IPC request timeout after 300000ms"
4. **Tool was configured for**: 10 minutes (600,000ms)

### Code Analysis

From `src/config.ts`:
```typescript
const DEFAULT_CONFIG: MCPLIConfig = {
  defaultTimeoutSeconds: 1800,    // 30 minutes - daemon
  defaultCliTimeoutSeconds: 30,    // 30 seconds - unused
  defaultIpcTimeoutMs: 300000,     // 5 minutes - IPC ← PROBLEM
  defaultToolTimeoutMs: 600000,    // 10 minutes - tools
};
```

From `src/daemon/client.ts`:
```typescript
// IPC timeout is applied to ALL requests including long-running tools
const result = await sendIPCRequest(ensureRes.socketPath, request, this.ipcTimeoutMs);
```

## Impact Analysis

### Affected Scenarios
1. Any tool operation taking 5-10 minutes fails with IPC timeout
2. Users who increased tool timeout still hit IPC timeout
3. Confusing error messages (IPC timeout vs tool timeout)

### Timeout Hierarchy Principle
**Fundamental Rule**: Lower-level timeouts must always be greater than higher-level timeouts.

```
Correct hierarchy (bottom to top):
- Network/Transport timeout > Application timeout
- IPC timeout > Tool timeout
- Socket timeout > Request timeout
```

## Root Cause

The root cause is a **design oversight** in timeout configuration where:
1. IPC timeout was set independently without considering tool timeout
2. No validation ensures IPC timeout > tool timeout
3. Default values violate the timeout hierarchy principle

## Recommended Solutions

### Solution 1: Fix Default Values (Immediate)
```typescript
const DEFAULT_CONFIG: MCPLIConfig = {
  defaultTimeoutSeconds: 1800,    // 30 minutes - daemon
  defaultCliTimeoutSeconds: 30,    // 30 seconds - unused
  defaultIpcTimeoutMs: 660000,    // 11 minutes - IPC (tool + 1 min buffer)
  defaultToolTimeoutMs: 600000,   // 10 minutes - tools
};
```

### Solution 2: Dynamic IPC Timeout (Better)
```typescript
// In src/daemon/client.ts
const cfg = getConfig();
// Ensure IPC timeout is always greater than tool timeout
this.ipcTimeoutMs = Math.max(
  cfg.defaultToolTimeoutMs + 60000,  // Tool timeout + 60s buffer
  this.options.ipcTimeoutMs ?? cfg.defaultIpcTimeoutMs
);
```

### Solution 3: Timeout Validation (Best)
```typescript
// In src/config.ts
export function validateTimeouts(config: MCPLIConfig): void {
  if (config.defaultIpcTimeoutMs <= config.defaultToolTimeoutMs) {
    console.warn(
      `Warning: IPC timeout (${config.defaultIpcTimeoutMs}ms) should be greater than ` +
      `tool timeout (${config.defaultToolTimeoutMs}ms). Adjusting IPC timeout.`
    );
    config.defaultIpcTimeoutMs = config.defaultToolTimeoutMs + 60000;
  }
}
```

### Solution 4: Per-Request Timeout (Most Flexible)
```typescript
// Pass appropriate timeout based on operation type
if (method === 'callTool') {
  // Use extended timeout for tool calls
  timeout = cfg.defaultToolTimeoutMs + 60000;
} else {
  // Use standard timeout for other operations
  timeout = this.ipcTimeoutMs;
}
const result = await sendIPCRequest(socketPath, request, timeout);
```

## Immediate Workaround

Users can set environment variables to fix the hierarchy:
```bash
export MCPLI_TOOL_TIMEOUT_MS=600000   # 10 minutes
export MCPLI_IPC_TIMEOUT=660000       # 11 minutes
```

## Lessons Learned

1. **Timeout Hierarchy**: Always validate that lower-level timeouts exceed higher-level timeouts
2. **Coupled Configuration**: Timeout values are interdependent and should be validated together
3. **Buffer Time**: Always add buffer time between layers (30-60 seconds recommended)
4. **Clear Documentation**: Document timeout dependencies and hierarchy
5. **Runtime Validation**: Add runtime checks to prevent invalid timeout configurations

## Prevention Measures

1. **Add timeout hierarchy validation** on startup
2. **Document timeout relationships** in configuration
3. **Use derived timeouts** where appropriate (IPC = tool + buffer)
4. **Add integration tests** for long-running operations
5. **Provide clear error messages** indicating which timeout was hit

## Testing Recommendations

1. Test with operations that take:
   - 30 seconds (pass)
   - 4 minutes (pass) 
   - 6 minutes (currently fails at 5 min, should pass)
   - 11 minutes (should fail with tool timeout)

2. Verify error messages clearly indicate which timeout occurred

## Configuration Best Practices

### Recommended Timeout Hierarchy
```
Daemon Inactivity:  30 minutes (1,800,000ms)
           ↓
IPC Transport:      11 minutes (660,000ms)  
           ↓
Tool Execution:     10 minutes (600,000ms)
           ↓
Individual Operations (varies)
```

### Timeout Buffer Guidelines
- Between layers: Add 10% or minimum 30 seconds
- For network operations: Add 60 seconds

## Resolution Implemented

- Default IPC timeout increased to exceed tool timeout by 1 minute:
  - `src/config.ts`: `defaultIpcTimeoutMs` set to `660000` (11 minutes)
- Per-request protection so IPC never undercuts tool operations:
  - `src/daemon/client.ts`: for `callTool`, IPC timeout uses `max(ipcTimeoutMs, toolTimeoutMs + 60000)`
- Ergonomics: front-facing tool timeout flag/env only
  - CLI: `--tool-timeout=<seconds>`; orchestrator propagates to wrapper
  - Env: `MCPLI_TOOL_TIMEOUT_MS`
- Unit coverage to prevent regressions:
  - `tests/unit/daemon-client-ipc-timeout.test.ts` verifies hierarchy for `callTool` vs `listTools`

These changes ensure long-running tools (up to the configured tool timeout) do not fail due to premature IPC timeouts while keeping other requests at the configured IPC timeout.
- For user-facing timeouts: Round to user-friendly values

## References

- Initial timeout issue: `MCPLI_TIMEOUT_RCA.md`
- Config implementation: `src/config.ts:44-48`
- IPC timeout application: `src/daemon/client.ts:146`
- Test evidence: Tmux session showing 5-minute IPC timeout
