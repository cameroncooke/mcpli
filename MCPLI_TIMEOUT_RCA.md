# Root Cause Analysis: MCPLI Timeout Issue with Long-Running Operations

## Executive Summary

MCPLI experiences timeout errors when executing long-running MCP tools (e.g., Xcode builds). The root cause is a **hardcoded 60-second timeout in the MCP SDK client library** that cannot be overridden by servers and is not currently configurable in MCPLI's implementation.

## Problem Statement

- **Symptom**: `Error: MCP error -32001: Request timed out` after approximately 60 seconds
- **Impact**: Unable to execute any MCP tool that takes longer than 60 seconds to complete
- **Affected Operations**: Xcode builds, large data processing, complex operations

## Timeline of Investigation

1. **Initial Hypothesis**: MCPLI's IPC timeout (5 minutes) was causing the issue
2. **Testing**: Direct measurement showed timeout at ~60 seconds, not 5 minutes
3. **Discovery**: Error code `-32001` originates from MCP server, not MCPLI
4. **Root Cause Found**: Hardcoded timeout in `@modelcontextprotocol/sdk` client library

## Technical Architecture

### Component Stack
```
┌─────────────┐
│   User CLI  │
└──────┬──────┘
       │ 
┌──────▼──────┐
│    MCPLI    │ ← No timeout applied here
└──────┬──────┘
       │ IPC (5 min timeout - NOT the issue)
┌──────▼──────┐
│ MCPLI Daemon│
│  (wrapper)  │ ← Uses MCP SDK Client
└──────┬──────┘
       │ stdio + MCP Protocol
┌──────▼──────┐
│ MCP Server  │ ← 60s timeout enforced by SDK
│(xcodebuildmcp)
└──────┬──────┘
       │ 
┌──────▼──────┐
│  xcodebuild │ ← Takes 60+ seconds
└─────────────┘
```

### Timeout Configuration Points

1. **MCPLI Configuration** (`src/config.ts`):
   - `defaultTimeoutSeconds: 1800` (30 minutes) - Daemon inactivity
   - `defaultCliTimeoutSeconds: 30` (30 seconds) - **UNUSED**
   - `defaultIpcTimeoutMs: 300000` (5 minutes) - IPC communication

2. **MCP SDK Client** (`@modelcontextprotocol/sdk`):
   - `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (60 seconds) - **THE CULPRIT**
   - Location: `node_modules/@modelcontextprotocol/sdk/dist/*/shared/protocol.js`
   - Error code: `-32001` (RequestTimeout)

3. **MCPLI Daemon** (`src/daemon/wrapper.ts:373-376`):
   ```typescript
   result = await this.mcpClient.callTool({
     name,
     arguments: args as Record<string, unknown> | undefined,
   });
   // No timeout option passed - uses SDK default of 60s
   ```

## Root Cause

The MCP SDK client library enforces a **60-second default timeout** for all tool calls. This timeout:
- Is hardcoded in the SDK as `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`
- Cannot be overridden by MCP servers
- Is not currently configurable in MCPLI's implementation
- Applies universally to all tool calls regardless of expected duration

## Evidence

### Test Results
- Direct xcodebuild execution: **66 seconds** to fail
- Via MCPLI/MCP: **60 seconds** timeout (before xcodebuild completes)
- Timeout occurs consistently at 60 seconds, not the 5-minute IPC timeout

### Code Analysis
```typescript
// From @modelcontextprotocol/sdk/dist/esm/shared/protocol.js
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;

// In Protocol.request() method:
const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
```

## Impact Analysis

### Affected Use Cases
1. **Build Operations**: Xcode builds, Android builds, large compilations
2. **Data Processing**: Large file transformations, batch operations
3. **Network Operations**: Slow API calls, large downloads
4. **Any operation > 60 seconds**

### Current Workarounds
None available without code changes.

## Recommended Solutions

### Solution 1: Configure Timeout in MCPLI (Recommended)
**Implementation**: Pass explicit timeout in `RequestOptions` when calling MCP tools

```typescript
// In src/daemon/wrapper.ts
const DEFAULT_TOOL_TIMEOUT_MS = 
  Number(process.env.MCPLI_TOOL_TIMEOUT_MS) || 10 * 60 * 1000; // 10 minutes

result = await this.mcpClient.callTool(
  { name, arguments: args },
  undefined,
  { timeout: DEFAULT_TOOL_TIMEOUT_MS } // Add timeout option
);
```

**Pros**:
- Simple implementation
- User-configurable via environment variable
- No SDK changes required

**Cons**:
- Requires MCPLI code change

### Solution 2: Modify MCP SDK (Long-term)
**Implementation**: Change default timeout in SDK or make it configurable

**Pros**:
- Fixes issue for all MCP clients
- More architecturally correct

**Cons**:
- Requires SDK modification and release
- Affects all SDK users

### Solution 3: Streaming/Progress Updates
**Implementation**: Use MCP's streaming capabilities to send progress updates

**Pros**:
- Provides user feedback
- Keeps connection alive

**Cons**:
- Requires server-side changes
- More complex implementation

## Immediate Workaround

Users can set a longer timeout by:
1. Setting environment variable (once implemented): `MCPLI_TOOL_TIMEOUT_MS=600000`
2. Using faster operations or breaking them into smaller chunks
3. Using tools that support incremental/streaming updates

## Lessons Learned

1. **Timeout Cascades**: Multiple timeout layers can obscure the actual limiting factor
2. **Default Values**: One-size-fits-all timeouts (60s) don't work for diverse operations
3. **Error Transparency**: Error messages should indicate timeout duration and source
4. **Configuration**: Timeouts should always be configurable, not hardcoded

## References

- MCP SDK Source: `@modelcontextprotocol/sdk/dist/*/shared/protocol.js`
- MCPLI Daemon: `src/daemon/wrapper.ts:359-378`
- Error Code Definition: `ErrorCode.RequestTimeout = -32001`
- Test Evidence: Tmux session showing 60-second timeout vs 66-second xcodebuild duration