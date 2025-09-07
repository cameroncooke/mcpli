# Root Cause Analysis: MCPLI_TOOL_TIMEOUT_MS Environment Variable ECONNREFUSED Error

Status: Resolved (verified 2025-09-05)

Update summary
- Environment variable path now mirrors `--tool-timeout` behavior; no ECONNREFUSED observed.
- Recent IPC/launchd robustness changes removed the race that previously surfaced after a
  client-side timeout followed by an immediate new request.

Short verification (fast repros)
- Flag path: `node dist/mcpli.js delay --seconds=12 --tool-timeout=5 -- node timeout-test-server.js`
  - Result: MCP error -32001 (request timed out) in ~5.5s; exit 1
- Env path: `MCPLI_TOOL_TIMEOUT_MS=5000 node dist/mcpli.js delay --seconds=12 -- node timeout-test-server.js`
  - Result: MCP error -32001 (request timed out) in ~5.1s; exit 1

Why this is fixed
- Added/raised IPC connect retry budget smooths transient ECONNREFUSED/ENOENT during activation.
- launchd runtime briefly polls for socket presence after (re)bootstrap, reducing races.
- IPC timeout auto-buffers above tool timeout for `callTool`, preventing IPC from undercutting tool timeouts.
- Unified timeout derivation: CLI flag, server env (after `--`), and process env (`MCPLI_TOOL_TIMEOUT_MS`) feed the same effective tool timeout.

Current guidance
- Both `--tool-timeout` and `MCPLI_TOOL_TIMEOUT_MS` are supported and behave consistently.

## Executive Summary
When using the `MCPLI_TOOL_TIMEOUT_MS` environment variable to set tool timeouts, MCPLI fails with "Error: connect ECONNREFUSED" instead of applying the timeout. This occurs despite the `--tool-timeout` CLI flag working correctly for the same operation.

## Issue Details

### Symptoms
- **Error Message**: `Error: connect ECONNREFUSED /var/folders/_t/2njffz894t57qpp76v1sw__h0000gn/T/mcpli/13175e13/1d3c498c.sock`
- **Affected Command**: `MCPLI_TOOL_TIMEOUT_MS=25000 node dist/mcpli.js delay --seconds=45 -- node timeout-test-server.js`
- **Expected Behavior**: Tool should timeout after 25 seconds with MCP error -32001
- **Actual Behavior**: Immediate connection refused error (3.064 seconds total runtime)

### Working Alternative
The `--tool-timeout` flag works correctly:
```bash
node dist/mcpli.js delay --seconds=45 --tool-timeout=30 -- node timeout-test-server.js
# Result: Correctly times out at 30 seconds with "MCP error -32001: Request timed out"
```

## Root Cause Analysis

### Primary Hypothesis: Daemon State Conflict

The most likely cause is that the daemon was still processing the previous timed-out request when the new request arrived. The timeline supports this:

1. **22:31:38** - Test 4 started (45-second delay with 30-second timeout)
2. **22:32:08** - Test 4 timed out at client side, but daemon continued processing
3. **22:32:23** - Daemon would have completed the 45-second delay
4. **22:32:39** - Test 5 attempted to connect (only 16 seconds after daemon completion)
5. **22:32:42** - ECONNREFUSED error

### Contributing Factors

#### 1. Daemon Single-Request Architecture
The daemon appears to handle one request at a time. When a client times out and disconnects, the daemon continues processing the request. If a new request arrives before completion, the daemon may be in an inconsistent state.

Evidence from logs:
- Daemon showed "Still delaying... 40/45 seconds elapsed" even after client timeout
- No "Delay completed" message before Test 5 attempted connection

#### 2. Socket State Management
The ECONNREFUSED error suggests the Unix domain socket exists but nothing is listening. This can occur when:
- The daemon process crashed or exited
- The daemon is in a state where it cannot accept new connections
- The socket file exists but the daemon has closed its listening socket

#### 3. Environment Variable Processing Path Differences
The environment variable path may trigger different initialization or connection logic compared to the CLI flag path:

```typescript
// src/daemon/client.ts:127-130
const fromFlag = parseMs(this.options.toolTimeoutMs);  // From --tool-timeout
const fromFrontEnv = parseMs((env as Record<string, unknown>).MCPLI_TOOL_TIMEOUT_MS);  // From env var
```

The environment variable is processed differently and may affect daemon startup or connection timing.

### Secondary Hypothesis: Daemon Restart Race Condition

Another possibility is that the environment variable path triggers daemon cleanup and restart, but the new daemon isn't ready when the client attempts to connect:

1. Client detects MCPLI_TOOL_TIMEOUT_MS environment variable
2. Client initiates daemon restart (if timeout changes require it)
3. Old daemon shuts down
4. Client attempts to connect before new daemon is listening
5. ECONNREFUSED error

## Verification Tests Performed

### Test Matrix
| Test | Method | Timeout | Duration | Result |
|------|--------|---------|----------|---------|
| 4 | --tool-timeout=30 | 30s | 45s delay | ✅ Timed out at 30s |
| 5 | MCPLI_TOOL_TIMEOUT_MS=25000 | 25s | 45s delay | ❌ ECONNREFUSED |

### Key Observations
1. Both tests used the same daemon ID (1d3c498c), confirming environment variables don't affect daemon identity
2. Test 5 occurred immediately after Test 4, suggesting daemon state interference
3. The error occurred after 3 seconds, not at connection time (0 seconds), suggesting some initial communication succeeded

## Impact Assessment

### Severity: Medium
- **Workaround Available**: Use `--tool-timeout` flag instead of environment variable
- **User Impact**: Environment variable configuration method is broken
- **Scope**: Affects all users relying on environment-based configuration

### Affected Use Cases
1. CI/CD pipelines using environment variables for configuration
2. Docker containers with environment-based settings
3. System-wide timeout configurations via shell profiles
4. Batch processing scripts with uniform timeout requirements

## Recommendations

### Immediate Mitigation
1. **Use CLI flags**: Prefer `--tool-timeout` over `MCPLI_TOOL_TIMEOUT_MS`
2. **Add delays**: Wait for daemon to complete previous operations before new requests
3. **Clean daemon state**: Use `mcpli daemon clean` between operations if issues occur

### Code Fixes Required

#### 1. Improve Daemon Request Handling
```typescript
// In daemon/wrapper.ts
async handleRequest(request) {
  if (this.isProcessingRequest) {
    // Queue request or reject with appropriate error
    throw new Error('Daemon is busy processing another request');
  }
  // ... continue processing
}
```

#### 2. Add Connection Retry Logic
```typescript
// In daemon/client.ts
async connect() {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await this.attemptConnection();
      return;
    } catch (err) {
      if (err.code === 'ECONNREFUSED' && i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      throw err;
    }
  }
}
```

#### 3. Fix Environment Variable Race Condition
Ensure daemon is fully initialized before client attempts connection when environment variables are used:
```typescript
// In daemon/runtime-launchd.ts
async ensureDaemon(opts) {
  // ... existing daemon creation logic
  
  // Wait for daemon to be ready
  if (daemonWasCreated) {
    await this.waitForDaemonReady(id, opts);
  }
  
  return { id, socket };
}
```

### Long-term Improvements

1. **Implement request cancellation**: When client times out, notify daemon to cancel operation
2. **Add request queueing**: Allow daemon to handle multiple requests
3. **Improve daemon health checks**: Verify daemon is ready before returning from ensure
4. **Add connection state logging**: Better diagnostics for connection issues
5. **Implement graceful shutdown**: Ensure daemon completes or cancels operations on shutdown

## Reproduction Steps

### Prerequisites
1. Build MCPLI with latest changes:
   ```bash
   cd /Volumes/Developer/mcpli
   npm run build
   ```

2. Create the timeout test server:
   ```bash
   cat > timeout-test-server.js << 'EOF'
   #!/usr/bin/env node
   import { Server } from '@modelcontextprotocol/sdk/server/index.js';
   import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
   // ... (full server code in repo)
   EOF
   ```

### Setup Tmux Session for Testing
1. Create or attach to tmux session 2:
   ```bash
   tmux new-session -s 2 || tmux attach -t 2
   ```

2. Split the window into two panes (if not already split):
   ```bash
   # Press Ctrl+b then % to split vertically
   ```

3. In the right pane (pane 1), start daemon log monitoring:
   ```bash
   cd /Volumes/Developer/mcpli
   node dist/mcpli.js daemon logs -- node timeout-test-server.js
   ```

### Reproduce the Issue

#### Using MCP tmux tools from Claude:
```typescript
// Step 1: Clean daemon state
mcp__tmux-mcp__execute-command(
  paneId: "$2:0.0",
  command: "cd /Volumes/Developer/mcpli && node dist/mcpli.js daemon clean"
)

// Step 2: Run successful test with --tool-timeout flag (baseline)
mcp__tmux-mcp__execute-command(
  paneId: "$2:0.0", 
  command: "time node dist/mcpli.js delay --seconds=45 --tool-timeout=30 -- node timeout-test-server.js 2>&1"
)
// Wait 31 seconds for timeout
// Expected: "Error: MCP error -32001: Request timed out" at 30 seconds

// Step 3: Immediately run test with environment variable (reproduces issue)
mcp__tmux-mcp__execute-command(
  paneId: "$2:0.0",
  command: "time MCPLI_TOOL_TIMEOUT_MS=25000 node dist/mcpli.js delay --seconds=45 -- node timeout-test-server.js 2>&1"
)
// Expected: Should timeout at 25 seconds
// Actual: "Error: connect ECONNREFUSED" within 3 seconds

// Step 4: Monitor daemon logs in second pane
mcp__tmux-mcp__capture-pane(
  paneId: "$2:0.1",
  lines: 30
)
// Observe: Daemon still processing previous request when new one arrives
```

#### Manual Command-Line Reproduction:
```bash
# Terminal 1 - Run tests
cd /Volumes/Developer/mcpli
node dist/mcpli.js daemon clean

# Test 1: Baseline with --tool-timeout (works)
time node dist/mcpli.js delay --seconds=45 --tool-timeout=30 -- node timeout-test-server.js
# Observe: Times out at 30 seconds with MCP error -32001

# Test 2: Immediately run with env var (fails)
time MCPLI_TOOL_TIMEOUT_MS=25000 node dist/mcpli.js delay --seconds=45 -- node timeout-test-server.js
# Observe: ECONNREFUSED error within 3 seconds

# Terminal 2 - Monitor daemon logs
cd /Volumes/Developer/mcpli  
node dist/mcpli.js daemon logs -- node timeout-test-server.js
# Observe: Daemon continues processing after client timeout
```

### Critical Timing for Reproduction
The key to reproducing this issue is the **timing between requests**:
1. First request must timeout (client disconnects but daemon continues)
2. Second request must arrive while daemon is still processing
3. This creates the ECONNREFUSED error

### Verification Steps
1. Check daemon state after timeout:
   ```bash
   ps aux | grep timeout-test-server
   # Should show daemon still running
   ```

2. Check socket file:
   ```bash
   ls -la /var/folders/_t/2njffz894t57qpp76v1sw__h0000gn/T/mcpli/13175e13/1d3c498c.sock
   # Socket exists but daemon not listening
   ```

3. Verify daemon ID consistency:
   ```bash
   # Without env var
   node dist/mcpli.js daemon start -- node timeout-test-server.js
   # Note daemon ID (e.g., 1d3c498c)
   
   # With env var (should be same ID)
   MCPLI_TOOL_TIMEOUT_MS=30000 node dist/mcpli.js daemon start -- node timeout-test-server.js
   # Should show same daemon ID
   ```

## Testing Recommendations

### Regression Test Suite
```bash
#!/bin/bash
# Test environment variable timeout with fresh daemon
mcpli daemon clean
MCPLI_TOOL_TIMEOUT_MS=10000 mcpli delay --seconds=15 -- node timeout-test-server.js
# Should timeout at 10 seconds

# Test rapid successive requests
mcpli delay --seconds=5 --tool-timeout=3 -- node timeout-test-server.js
sleep 1
MCPLI_TOOL_TIMEOUT_MS=3000 mcpli quick -- node timeout-test-server.js
# Second command should succeed

# Test environment variable with daemon already running
mcpli quick -- node timeout-test-server.js  # Start daemon
MCPLI_TOOL_TIMEOUT_MS=5000 mcpli delay --seconds=10 -- node timeout-test-server.js
# Should timeout at 5 seconds
```

## Conclusion

The MCPLI_TOOL_TIMEOUT_MS environment variable fails due to daemon state management issues when requests timeout. The daemon continues processing after client disconnection, leaving it unable to handle new requests. While the `--tool-timeout` flag provides a reliable workaround, the environment variable path needs fixes to:

1. Handle daemon busy states gracefully
2. Implement connection retry logic
3. Ensure proper daemon lifecycle management

The issue is most likely to occur when:
- Multiple requests are made in quick succession
- Previous requests have timed out
- Environment variables are used instead of CLI flags

Until fixed, users should prefer the `--tool-timeout` CLI flag for reliable timeout configuration.
