# MCPLI Long-Lived Server Architecture

## Overview

Transform MCPLI from a stateless model (spawn server per command) to a stateful model where MCP servers run as long-lived background processes that persist across CLI invocations.

## Current Architecture vs. Target Architecture

### Current (Stateless)
```
mcpli --echo message="hello" -- node server.js
  ↓
1. Spawn MCP server process
2. Connect via stdio
3. List tools, call tool
4. Close connection, kill process
```

### Target (Stateful)
```
mcpli daemon start -- node server.js     # Start long-lived server
mcpli --echo message="hello"             # Fast execution via IPC
mcpli daemon stop                        # Manual cleanup
```

## Design Principles

1. **Folder-based isolation**: One server instance per working directory
2. **Automatic discovery**: Commands work seamlessly whether server is running or not
3. **Graceful fallback**: If daemon fails, fall back to stateless mode
4. **Resource management**: Automatic cleanup after inactivity
5. **Simple UX**: Users shouldn't need to think about process management

## File Structure

```
.mcpli/
├── daemon.lock          # Combined lock/PID file
├── daemon.sock          # Unix domain socket for IPC
├── daemon.log           # Server logs (if --logs enabled)
└── daemon.config.json   # Server configuration cache
```

## Core Components

### 1. Lock/PID File Management

**File**: `.mcpli/daemon.lock`
```json
{
  "pid": 12345,
  "socket": ".mcpli/daemon.sock",
  "command": "node server.js",
  "args": [],
  "started": "2024-01-15T10:30:00Z",
  "lastAccess": "2024-01-15T11:45:00Z"
}
```

**Implementation**:
- Use `proper-lockfile` for atomic lock acquisition
- Store both PID and IPC connection details
- Update `lastAccess` on every command
- Clean up on graceful shutdown

### 2. Process Lifecycle Management

#### Starting a Daemon
```bash
# Explicit start
mcpli daemon start -- node server.js

# Auto-start (if no daemon running)
mcpli --echo message="test"  # Starts daemon transparently
```

**Flow**:
1. Check if `.mcpli/daemon.lock` exists and is valid
2. If not, acquire exclusive lock on the file
3. Spawn detached MCP server process
4. Write daemon info to lock file
5. Set up Unix domain socket for IPC
6. Cache discovered tools in `daemon.config.json`

#### Daemon Process Setup
```javascript
// daemon-manager.js
async function startDaemon(command, args, options) {
  const lockPath = path.join(process.cwd(), '.mcpli', 'daemon.lock');
  const release = await lock(lockPath, { retries: 0 });
  
  const daemon = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'ignore', options.logs ? 'inherit' : 'ignore']
  });
  
  const daemonInfo = {
    pid: daemon.pid,
    socket: '.mcpli/daemon.sock',
    command,
    args,
    started: new Date().toISOString(),
    lastAccess: new Date().toISOString()
  };
  
  await fs.writeFile(lockPath, JSON.stringify(daemonInfo));
  daemon.unref();
  
  // Set up cleanup handlers
  process.on('SIGTERM', async () => {
    await release();
    await fs.unlink(lockPath);
  });
}
```

### 3. Inter-Process Communication

**Transport**: Unix Domain Sockets (cross-platform via Node.js `net` module)
**Protocol**: JSON-RPC over socket

#### Server Side (in spawned MCP server wrapper)
```javascript
// daemon-wrapper.js - wraps the actual MCP server
import net from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const server = net.createServer((client) => {
  client.on('data', async (data) => {
    try {
      const request = JSON.parse(data.toString());
      const response = await handleRequest(request);
      client.write(JSON.stringify(response));
    } catch (error) {
      client.write(JSON.stringify({ error: error.message }));
    }
  });
});

async function handleRequest(request) {
  switch (request.method) {
    case 'listTools':
      return await mcpClient.listTools();
    case 'callTool':
      return await mcpClient.callTool(request.params);
    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}
```

#### Client Side (MCPLI)
```javascript
// daemon-client.js
async function callDaemon(method, params) {
  const sockPath = path.join(process.cwd(), '.mcpli', 'daemon.sock');
  
  return new Promise((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      const request = { method, params, id: Date.now() };
      client.write(JSON.stringify(request));
    });
    
    client.on('data', (data) => {
      const response = JSON.parse(data.toString());
      client.end();
      resolve(response);
    });
    
    client.on('error', reject);
  });
}
```

### 4. Command Execution Flow

#### Fast Path (Daemon Running)
```javascript
async function executeCommand(selectedTool, params, options) {
  try {
    // Try daemon first
    if (await isDaemonRunning()) {
      await updateLastAccess();
      const result = await callDaemon('callTool', { name: selectedTool.name, arguments: params });
      return result;
    }
  } catch (error) {
    if (options.debug) {
      console.error('[DEBUG] Daemon failed, falling back to direct mode:', error.message);
    }
  }
  
  // Fallback to stateless mode
  return executeStateless(selectedTool, params, options);
}
```

#### Automatic Daemon Startup
```javascript
async function ensureDaemonRunning(childCommand, childArgs, options) {
  if (!(await isDaemonRunning())) {
    if (options.debug) {
      console.error('[DEBUG] Starting daemon automatically');
    }
    await startDaemon(childCommand, childArgs, options);
    
    // Wait for daemon to be ready
    await waitForDaemon(5000); // 5 second timeout
  }
}
```

### 5. Resource Management

#### Inactivity Timeout
```javascript
// In daemon-wrapper.js
let inactivityTimeout;
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function resetInactivityTimer() {
  clearTimeout(inactivityTimeout);
  inactivityTimeout = setTimeout(gracefulShutdown, TIMEOUT_MS);
}

function gracefulShutdown() {
  console.log('Daemon shutting down due to inactivity');
  server.close();
  fs.unlink('.mcpli/daemon.lock');
  process.exit(0);
}

// Reset timer on each request
server.on('connection', resetInactivityTimer);
```

#### Manual Cleanup Commands
```bash
mcpli daemon stop     # Graceful shutdown
mcpli daemon restart  # Stop and start
mcpli daemon status   # Show daemon info
mcpli daemon logs     # Show daemon logs
```

### 6. Error Handling & Fallbacks

#### Daemon Health Checks
```javascript
async function isDaemonRunning() {
  try {
    const lockPath = path.join(process.cwd(), '.mcpli', 'daemon.lock');
    const lockData = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    
    // Check if PID is still running
    try {
      process.kill(lockData.pid, 0); // Test signal
      return true;
    } catch {
      // Process not running, clean up stale lock
      await fs.unlink(lockPath);
      return false;
    }
  } catch {
    return false;
  }
}
```

#### Graceful Degradation
1. **Daemon unavailable**: Fall back to stateless mode
2. **Socket connection fails**: Retry once, then fall back
3. **Stale lock files**: Clean up and start fresh daemon
4. **Corrupted state**: Reset to clean state

## Implementation Plan

### Phase 1: Core Infrastructure
1. **Lock file management** (`src/daemon/lock.ts`)
2. **Process spawning** (`src/daemon/spawn.ts`)
3. **IPC setup** (`src/daemon/ipc.ts`)
4. **Health checks** (`src/daemon/health.ts`)

### Phase 2: Command Integration
1. **Modify main CLI** to check for daemon first
2. **Add daemon subcommands** (`start`, `stop`, `status`, `restart`)
3. **Implement fallback logic**
4. **Add auto-start capability**

### Phase 3: Polish & Testing
1. **Comprehensive error handling**
2. **Cross-platform testing** (Windows, macOS, Linux)
3. **Performance benchmarking** (startup time improvements)
4. **Documentation and examples**

## Expected Benefits

1. **Performance**: ~100-1000x faster command execution (no spawn overhead)
2. **State preservation**: Tools can maintain caches, connections, etc.
3. **Better resource usage**: One server process vs many short-lived processes
4. **Enhanced capabilities**: Enables features like file watching, real-time updates

## Migration Strategy

1. **Backward compatibility**: All existing commands work unchanged
2. **Opt-in initially**: Users can explicitly start daemons
3. **Gradual rollout**: Auto-start behind feature flag
4. **Fallback guaranteed**: Stateless mode always available

## Security Considerations

1. **Socket permissions**: Restrict `.mcpli/daemon.sock` to owner only
2. **PID verification**: Ensure we're signaling the correct process
3. **Directory isolation**: Each project gets its own daemon instance
4. **Cleanup on exit**: Remove sockets and lock files on shutdown

This architecture transforms MCPLI from a simple wrapper to a sophisticated process management system while maintaining the simple CLI interface users expect.