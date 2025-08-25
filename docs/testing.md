# MCPLI Daemon System – Manual Testing Guide

This document provides practical, copy‑pasteable steps to manually verify MCPLI’s daemon system:

- Automatic daemon management
- No duplicate spawning for the same command + args
- Server command requirement enforcement (always requires `-- <command>`)
- Multiple daemons coexisting (command‑specific isolation by hash)
- Fallback to stateless mode when daemon IPC fails
- Command‑specific tests using the included servers:
  - weather-server.js
  - complex-test-server.js

All commands assume you are in the MCPli repository root.

Requirements:
- Node.js 18+ (for global fetch and ESM)
- npm install completed in the repo root: `npm install`

How to run the CLI:
- If you installed mcpli globally (via `npm i -g`), use:
  - `mcpli` (as shown in examples)
- Or run from source with ts-node (npx will fetch it if needed):
  - Replace `mcpli` in commands below with: `npx ts-node src/mcpli.ts`
- Or if you have built artifacts:
  - Replace `mcpli` with: `node dist/mcpli.js`

For readability, the examples below use `mcpli`. If you do not have a global install, replace `mcpli` with `npx ts-node src/mcpli.ts`.

Notes:
- On Windows PowerShell, use double quotes instead of single quotes.
- Daemons are scoped per working directory (per‑CWD). Running from another directory will create a different set of daemons.

## Available Test Servers

This repository includes three test MCP servers for testing different scenarios:

### weather-server.js
- **Purpose**: Full-featured MCP server with external API calls
- **Tools**: `get-weather`, `get-forecast`  
- **Description**: Provides weather information using the free Open-Meteo API
- **Use cases**: Testing real-world API interactions, network timeouts, complex responses
- **Command**: `node weather-server.js`

### test-server.js  
- **Purpose**: Simple, reliable test server with no external dependencies
- **Tools**: `echo`, `fail` (intentionally throws errors), `delay` (configurable delays)
- **Description**: Basic echo server for testing core daemon functionality
- **Use cases**: Basic daemon communication, error handling, timeout testing
- **Command**: `node test-server.js`

### complex-test-server.js
- **Purpose**: Comprehensive JSON Schema validation testing
- **Tools**: `test_all_types` (supports all JSON Schema data types)
- **Description**: Tests complex parameter validation, arrays, objects, enums
- **Use cases**: CLI argument parsing, schema validation, complex data structures  
- **Command**: `node complex-test-server.js`

**Recommendation**: Use `weather-server.js` for general testing and `test-server.js` for reliability/speed in daemon lifecycle tests.

---

## 1) First‑time automatic daemon startup (Weather server)

This proves MCPLI auto‑starts a daemon for the given server command.

- Start the weather tool (first time will auto‑spawn a daemon for `node weather-server.js`):

```bash
mcpli get-weather --location "New York" -- node weather-server.js
```

Expected:
- You should receive a JSON object with current weather info for New York.
- The first run will take a bit longer as the daemon is created.

- Verify the daemon is running:

```bash
mcpli daemon status
```

Expected (example):
- One daemon displayed with a short ID, e.g.:
  - `Daemon ab12cd34:`
  - `Status: Running`
  - `PID: 12345`
  - `Command: node /path/to/weather-server.js`
  - `IPC connection: OK`
  - `Socket: /path/to/repo/.mcpli/daemon-ab12cd34.sock`

---

## 2) Daemon reuse (no duplicate spawns for the same command)

This confirms MCPLI reuses the existing daemon for identical command + args.

- Run the same weather tool again (still providing the command to be explicit):

```bash
mcpli get-weather --location "Boston" -- node weather-server.js
```

Expected:
- Faster execution (daemon reuse).
- Output returns Boston weather JSON.

- Check status and confirm the PID is unchanged:

```bash
mcpli daemon status
```

- Explicitly ask MCPLI to start the daemon again for the same command:

```bash
mcpli daemon start -- node weather-server.js
```

Expected:
- You should see: `Daemon is already running for this command (PID X)` (proves no duplicate spawn).

Tip:
- Command path normalization is applied (absolute path + normalized separators), so `node weather-server.js` and `node ./weather-server.js` should target the same daemon in the same CWD.

---

## 3) Server command always required (consistent with README)

MCPLI requires the server command after `--` on every invocation, as documented in the README.

- Attempt to call a tool without server command (should fail):

```bash
mcpli get-weather --location "Seattle"
```

Expected:
- `Error: No daemon running and no server command provided`
- This confirms that server commands are always required as per design.

- Call the same tool again with the server command (should reuse daemon):

```bash
mcpli get-weather --location "Seattle" -- node weather-server.js
```

Expected:
- Returns weather data by reusing the existing daemon.
- Confirms daemon reuse while maintaining requirement for explicit server command.

---

## 4) Multiple daemons coexisting (multi‑daemon test)

This shows separate daemons for different server commands.

- Start and use the complex test server (this will spawn a second daemon):

```bash
mcpli test-all-types --text "hello" --count 2 --enabled --tags '["x","y"]' -- node complex-test-server.js
```

Expected:
- You’ll get a textual echo of received arguments and types.
- A new daemon for `node complex-test-server.js` is created.

- Verify both daemons are running:

```bash
mcpli daemon status
```

Expected:
- Two daemon entries (one for weather-server.js and one for complex-test-server.js), each with its own ID, PID, socket, and command line.

---

## 5) Isolation by command hash (different args -> different daemon)

Daemon IDs are based on normalized command + args; changing args creates a new, isolated daemon.

- Run the same complex server but change the node invocation arguments:

```bash
mcpli test-all-types --text "again" --count 3 -- node --trace-warnings complex-test-server.js
```

Expected:
- A third daemon is created because the command + args differ (the `--trace-warnings` flag is part of the daemon’s identity).
- `mcpli daemon status` should now show three entries.

- Similarly, running the same server with different command shapes in the same CWD creates isolated daemons, e.g.:
  - `node complex-test-server.js` vs `node --trace-warnings complex-test-server.js`

---

## 6) Manual daemon management commands

The following commands let you manage daemons directly.

- Show all daemons in the current directory:

```bash
mcpli daemon status
```

- Stop a specific daemon by specifying its command (computed to the same ID internally):

```bash
mcpli daemon stop -- node complex-test-server.js
```

- Stop all daemons in the current directory:

```bash
mcpli daemon stop
```

- Restart a specific daemon:

```bash
mcpli daemon restart -- node weather-server.js
```

- Restart all daemons (no command specified):

```bash
mcpli daemon restart
```

- View daemon logs (if started with `--logs` or `--verbose`):

```bash
mcpli daemon logs
```

- Clean up daemon files (stops running daemons where possible, removes stale locks/sockets):

```bash
mcpli daemon clean
```

Notes:
- To enable log capture in the daemon file, start the daemon with logging:
  - `mcpli daemon start --logs -- node weather-server.js`
  - Or call tools with `--verbose` (propagates log preference to auto‑daemon).

---

## 7) Fallback to stateless mode (when daemon IPC fails)

MCPLI will fallback to direct stateless execution if daemon IPC fails (only when a server command is provided with `--`).

Simulate broken IPC for the weather daemon:

1) Confirm daemon is running:

```bash
mcpli daemon status
```

Note the `Socket:` path for the weather daemon (e.g. `.mcpli/daemon-ab12cd34.sock`).

2) Remove the socket file while the process is still running:

- macOS/Linux:

```bash
rm -f .mcpli/daemon-*.sock
```

- Windows PowerShell:

```powershell
Remove-Item .mcpli\daemon-*.sock -Force
```

3) Call a weather tool again with `--debug` and provide the server command (enables fallback path):

```bash
mcpli --debug --logs get-weather --location "Berlin" -- node weather-server.js
```

Expected:
- You should see debug output similar to:
  - `[DEBUG] Daemon listTools failed, falling back to stateless:`
- The command still succeeds because MCPLI connects directly to the MCP server in stateless mode.

4) Check status again (IPC may show failed):

```bash
mcpli daemon status
```

Expected:
- The weather daemon may still show "IPC connection: FAILED" (until restarted).

5) Repair by restarting the daemon:

```bash
mcpli daemon restart -- node weather-server.js
```

---

## 8) Error scenarios

- Missing daemon + no server command:

```bash
mcpli get-weather --location "Tokyo"
```

Expected:
- `Error: No daemon running and MCP server command not provided`
- Use `-- <server command>` the first time or start the daemon explicitly.

- Unknown tool name (lists available tools):

```bash
mcpli not-a-tool -- node weather-server.js
```

Expected:
- `Error: No tool specified or tool not found`
- The output will list available tools.

- Input validation errors (schema‑driven parsing):

```bash
mcpli test-all-types --text "hello" --count not-a-number -- node complex-test-server.js
```

Expected:
- `Error: Argument --count expects an integer, but received "not-a-number".`

---

## 9) Command‑specific testing with included servers

### Weather server (weather-server.js)

- Show high‑level help (tool discovery):

```bash
mcpli --help -- node weather-server.js
```

- Get tool‑level help for the weather tool:

```bash
mcpli get-weather --help -- node weather-server.js
```

- Get current weather by city name:

```bash
mcpli get-weather --location "San Francisco" -- node weather-server.js
```

- Get current weather by coordinates (lat,lon):

```bash
mcpli get-weather --location "37.7749,-122.4194" -- node weather-server.js
```

- Get a multi‑day forecast:

```bash
mcpli get-forecast --location "London, UK" --days 3 -- node weather-server.js
```

- All subsequent runs still require the server command (consistent with README):

```bash
mcpli get-weather --location "Austin, TX" -- node weather-server.js
```

### Complex test server (complex-test-server.js)

- Discover tools:

```bash
mcpli --help -- node complex-test-server.js
```

- Run with diverse types:

```bash
mcpli test-all-types \
  --text "alpha" \
  --count 5 \
  --rating 4.25 \
  --enabled \
  --tags '["one","two"]' \
  --scores '[10.5, 20.75]' \
  --config '{"timeout":2.5,"retries":3,"debug":true}' \
  --metadata '{"user":{"id":7,"name":"Ada","preferences":["fast","quiet"]},"timestamps":[1710000000,1710003600]}' \
  -- node complex-test-server.js
```

Expected:
- Echoed arguments and derived types (string, integer, number, boolean, array, object, null where provided).

---

## 10) Per‑directory scoping check

Daemons are scoped to the current working directory.

- Create a temp directory and run from there:

```bash
mkdir -p tmp/mcpli-test && cd tmp/mcpli-test
mcpli daemon status
```

Expected:
- `No daemons found in this directory` (even if you have daemons running in the repo root).

- Start a daemon here (use a relative or absolute path to the server file):

```bash
mcpli get-weather --location "Dublin" -- node ../../weather-server.js
mcpli daemon status
```

Expected:
- A new daemon exists, isolated from the ones in the repo root.

- Cleanup:

```bash
mcpli daemon stop
cd ../../
```

---

## 11) Timeout processes testing

### 11.1) Daemon inactivity timeout

Test that daemons automatically shut down after timeout period.

```bash
# Start daemon with short timeout (60 seconds)
mcpli daemon start --timeout=60 -- node weather-server.js

# Check status immediately
mcpli daemon status

# Wait 70 seconds, then check status again
sleep 70 && mcpli daemon status
```

Expected:
- Initially shows running daemon
- After timeout, shows "No daemons found in this directory"

### 11.2) CLI timeout configuration

Test timeout configuration via CLI and environment variables.

```bash
# Test CLI timeout flag
mcpli get-weather --timeout=30 --location "NYC" -- node weather-server.js

# Test environment variable
export MCPLI_DEFAULT_TIMEOUT=120
mcpli get-weather --location "Boston" -- node weather-server.js
unset MCPLI_DEFAULT_TIMEOUT
```

Expected:
- Daemon uses specified timeout values
- Environment variable is overridden by CLI flag

### 11.3) IPC timeout handling

Test IPC connection timeout behavior.

```bash
# Start daemon, then break socket manually
mcpli daemon start --debug -- node weather-server.js
rm -f .mcpli/daemon-*.sock

# Try to call tool with short debug timeout (should fallback to stateless)
mcpli --debug get-weather --location "Berlin" -- node weather-server.js
```

Expected:
- Shows "Daemon callTool failed, falling back to stateless" message
- Command still succeeds via stateless mode

## 12) Cleanup scenario testing

### 12.1) Stale lock file cleanup

Test cleanup of stale daemon locks (process no longer exists).

```bash
# Start daemon and note PID
mcpli daemon start -- node weather-server.js
mcpli daemon status  # Note the PID

# Kill daemon process directly (simulates crash)
kill -9 <PID>

# Try daemon status (should clean up stale lock)
mcpli daemon status
```

Expected:
- Status command detects stale lock and cleans it up
- Shows "No daemons found in this directory" after cleanup

### 12.2) Missing socket file recovery

Test daemon recovery when socket file is missing but process is running.

```bash
# Start daemon
mcpli daemon start -- node weather-server.js

# Remove just the socket file (leave lock)
rm -f .mcpli/daemon-*.sock

# Check status (should show IPC connection failed)
mcpli daemon status

# Restart should work
mcpli daemon restart -- node weather-server.js
```

Expected:
- Status shows "IPC connection: FAILED"
- Restart succeeds and creates new socket

### 12.3) Orphaned socket cleanup

Test cleanup of socket files with no corresponding lock.

```bash
# Create orphaned socket file
mkdir -p .mcpli
touch .mcpli/daemon-orphan123.sock

# Run cleanup command
mcpli daemon clean

# Verify orphaned socket was removed
ls -la .mcpli/
```

Expected:
- Cleanup removes orphaned socket files
- Shows "Daemon cleanup complete"

### 12.4) Concurrent daemon cleanup

Test cleanup behavior when multiple processes try to clean simultaneously.

```bash
# Create some stale files
mkdir -p .mcpli
echo '{"pid":999999}' > .mcpli/daemon-stale.lock
touch .mcpli/daemon-stale.sock

# Run cleanup in parallel
mcpli daemon clean & mcpli daemon clean & wait
```

Expected:
- Both cleanup commands complete successfully
- No errors from concurrent file operations

## 13) Error handling testing

### 13.1) Permission denied errors

Test daemon behavior with permission issues.

```bash
# Create read-only .mcpli directory
mkdir -p .mcpli
chmod 444 .mcpli

# Try to start daemon (should fail gracefully)
mcpli daemon start -- node weather-server.js

# Restore permissions
chmod 755 .mcpli
```

Expected:
- Clear error message about permission denied
- No crash or hanging

### 13.2) Invalid MCP server command

Test behavior with non-existent or failing MCP server.

```bash
# Try with non-existent command
mcpli --debug get-weather --location "NYC" -- node non-existent-server.js

# Try with command that exits immediately
mcpli --debug --help -- node -e "process.exit(1)"
```

Expected:
- Clear error messages about server startup failure
- Fallback to stateless mode fails appropriately

### 13.3) Malformed daemon lock files

Test recovery from corrupted daemon metadata.

```bash
# Create invalid lock file
mkdir -p .mcpli
echo "invalid-json" > .mcpli/daemon-bad123.lock

# Try daemon status (should handle gracefully)
mcpli daemon status

# Try cleanup (should remove bad lock)
mcpli daemon clean
```

Expected:
- Status handles invalid JSON gracefully
- Cleanup removes malformed lock files

### 13.4) Network/socket errors

Test IPC error handling.

```bash
# Start daemon
mcpli daemon start -- node weather-server.js

# Make socket unreadable
chmod 000 .mcpli/daemon-*.sock

# Try to use daemon (should fallback)
mcpli --debug get-weather --location "NYC" -- node weather-server.js

# Restore permissions
chmod 600 .mcpli/daemon-*.sock
```

Expected:
- Falls back to stateless mode with socket permission error
- Clear debug messages about IPC failure

## 14) Edge cases and concurrency

### 14.1) Concurrent daemon startup

Test multiple processes trying to start same daemon.

```bash
# Try to start same daemon simultaneously
mcpli daemon start -- node weather-server.js &
mcpli daemon start -- node weather-server.js &
wait
```

Expected:
- Only one daemon starts successfully
- Other attempt shows "Daemon is already running"

### 14.2) Environment-aware daemon isolation

Test correct environment variable isolation: only CommandSpec env (after --) affects daemon identity, not shell env.

```bash
# SETUP: Clean state
mcpli daemon clean

# TEST 1: Shell env should NOT create different daemons
API_KEY=test1 mcpli daemon start -- node weather-server.js
DAEMON1_ID=$(mcpli daemon status -- node weather-server.js | grep "Daemon" | cut -d' ' -f2 | cut -d':' -f1)

API_KEY=test2 mcpli daemon start -- node weather-server.js  
DAEMON2_ID=$(mcpli daemon status -- node weather-server.js | grep "Daemon" | cut -d' ' -f2 | cut -d':' -f1)

test "$DAEMON1_ID" = "$DAEMON2_ID" || { echo "FAIL: Shell env should not create different daemons"; exit 1; }
echo "PASS: Shell environment variables do not affect daemon identity"

# TEST 2: CommandSpec env (after --) SHOULD create different daemons  
mcpli daemon start -- API_KEY=test1 node weather-server.js
DAEMON3_ID=$(mcpli daemon status -- API_KEY=test1 node weather-server.js | grep "Daemon" | cut -d' ' -f2 | cut -d':' -f1)

mcpli daemon start -- API_KEY=test2 node weather-server.js
DAEMON4_ID=$(mcpli daemon status -- API_KEY=test2 node weather-server.js | grep "Daemon" | cut -d' ' -f2 | cut -d':' -f1)

test "$DAEMON3_ID" != "$DAEMON4_ID" || { echo "FAIL: CommandSpec env should create different daemons"; exit 1; }
echo "PASS: CommandSpec environment variables create separate daemons"

# TEARDOWN
mcpli daemon clean
```

Expected:
- Shell env vars (before mcpli): Same daemon ID reused
- CommandSpec env vars (after --): Different daemon IDs created

### 14.3) Rapid start/stop cycles

Test daemon lifecycle under rapid changes.

```bash
# Rapid start/stop cycle
for i in {1..5}; do
  mcpli daemon start -- node weather-server.js
  mcpli daemon stop -- node weather-server.js
done

# Verify clean state
mcpli daemon status
```

Expected:
- All cycles complete successfully
- Final state shows no daemons running
- No leftover files in .mcpli/

### 14.4) Maximum daemon limits

Test behavior with many concurrent daemons.

```bash
# Start multiple daemons with different commands
for port in {3001..3010}; do
  mcpli daemon start -- node weather-server.js --port $port &
done
wait

# Check all are running
mcpli daemon status | wc -l

# Clean up all
mcpli daemon stop
```

Expected:
- All daemons start successfully with unique IDs
- System handles multiple concurrent daemons
- Cleanup stops all daemons properly

## 15) Daemon lifecycle integrity testing

### 15.1) Automatic process timeout termination

Test that daemon processes automatically terminate after their configured timeout period.

```bash
# SETUP: Ensure clean state and verify no existing daemons
mcpli daemon clean
mcpli daemon status  # Should show "No daemons found"
ls .mcpli/ 2>/dev/null && echo "SETUP FAIL: .mcpli directory exists" || echo "SETUP OK: Clean state"

# ACTION: Start daemon with very short timeout (8 seconds for faster testing)
mcpli daemon start --timeout=8 -- node weather-server.js

# ASSERT INITIAL STATE: Verify daemon is running
DAEMON_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')
SOCKET_FILE=$(mcpli daemon status | grep "Socket:" | awk '{print $2}')
LOCK_FILE="${SOCKET_FILE%.sock}.lock"

echo "ASSERT: Daemon PID: $DAEMON_PID"
test -n "$DAEMON_PID" || { echo "FAIL: No daemon PID found"; exit 1; }
kill -0 $DAEMON_PID || { echo "FAIL: Daemon process not running"; exit 1; }
test -S "$SOCKET_FILE" || { echo "FAIL: Socket file missing"; exit 1; }
test -f "$LOCK_FILE" || { echo "FAIL: Lock file missing"; exit 1; }
echo "SETUP COMPLETE: Daemon running with PID $DAEMON_PID"

# ACTION: Wait for timeout period to expire (8 seconds + 2 second buffer)
echo "Waiting 10 seconds for daemon timeout..."
sleep 10

# ASSERT TIMEOUT CLEANUP: Verify daemon terminated and cleaned up
echo "ASSERTING: Daemon should be terminated and cleaned up"
mcpli daemon status | grep "No daemons found" || { echo "FAIL: Daemon status shows running daemons"; exit 1; }
kill -0 $DAEMON_PID 2>/dev/null && { echo "FAIL: Daemon process still exists"; exit 1; } || echo "PASS: Daemon process terminated"
test -S "$SOCKET_FILE" && { echo "FAIL: Socket file still exists"; exit 1; } || echo "PASS: Socket cleaned up"
test -f "$LOCK_FILE" && { echo "FAIL: Lock file still exists"; exit 1; } || echo "PASS: Lock cleaned up"

# ASSERT NO ORPHANS: Verify no orphaned processes
ps aux | grep -v grep | grep "weather-server.js" && { echo "FAIL: Orphaned processes found"; exit 1; } || echo "PASS: No orphaned processes"

echo "TEST 15.1 PASSED: Automatic timeout termination working correctly"
```

Expected Results:
- SETUP: Clean state confirmed, no existing daemons
- INITIAL STATE: Daemon running with valid PID, socket, and lock files
- TIMEOUT ACTION: Daemon automatically terminates after 8 seconds
- CLEANUP VERIFICATION: All files removed, no orphaned processes

### 15.2) Optimistic cleanup when starting expired daemons

Test that starting a new daemon automatically cleans up stale/expired daemon artifacts.

```bash
# SETUP: Ensure clean state
mcpli daemon clean
mcpli daemon status | grep "No daemons found" || { echo "SETUP FAIL: Existing daemons"; exit 1; }

# ACTION: Start daemon with short timeout and let it expire
mcpli daemon start --timeout=3 -- node weather-server.js
FIRST_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')
SOCKET_FILE=$(mcpli daemon status | grep "Socket:" | awk '{print $2}')
LOCK_FILE="${SOCKET_FILE%.sock}.lock"

echo "SETUP: First daemon PID: $FIRST_PID"
test -n "$FIRST_PID" || { echo "SETUP FAIL: No daemon started"; exit 1; }
kill -0 $FIRST_PID || { echo "SETUP FAIL: Daemon not running"; exit 1; }

# Wait for daemon to expire naturally
echo "Waiting 5 seconds for daemon to timeout..."
sleep 5

# ASSERT EXPIRED STATE: Verify process is dead but files might remain (simulating stale state)
kill -0 $FIRST_PID 2>/dev/null && { echo "FAIL: Daemon process should be expired"; exit 1; } || echo "ASSERT: First daemon expired"

# Create stale artifacts to simulate unclean shutdown (if they don't exist)
if [ ! -f "$LOCK_FILE" ]; then
    echo '{"pid":99999,"socket":"'$SOCKET_FILE'","started":"2024-01-01T00:00:00.000Z"}' > "$LOCK_FILE"
    echo "SETUP: Created stale lock file for testing"
fi

# ASSERT STALE STATE: Verify stale artifacts exist
test -f "$LOCK_FILE" || { echo "SETUP FAIL: No stale lock file to clean"; exit 1; }
STALE_COUNT=$(ls .mcpli/daemon-*.lock 2>/dev/null | wc -l)
echo "ASSERT: Found $STALE_COUNT stale lock files before cleanup"
test "$STALE_COUNT" -gt 0 || { echo "SETUP FAIL: No stale files to test cleanup"; exit 1; }

# ACTION: Start new daemon (should trigger optimistic cleanup)
echo "Starting new daemon - should clean up stale artifacts"
mcpli daemon start -- node weather-server.js
NEW_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')

# ASSERT CLEANUP: Verify only one daemon running and stale artifacts cleaned
RUNNING_COUNT=$(mcpli daemon status | grep -c "Status: Running")
echo "ASSERT: $RUNNING_COUNT daemons running after new startup"
test "$RUNNING_COUNT" -eq 1 || { echo "FAIL: Expected 1 daemon, found $RUNNING_COUNT"; exit 1; }

test -n "$NEW_PID" || { echo "FAIL: New daemon not started"; exit 1; }
test "$NEW_PID" != "$FIRST_PID" || { echo "FAIL: Should be new daemon instance"; exit 1; }
kill -0 $NEW_PID || { echo "FAIL: New daemon not running"; exit 1; }

echo "PASS: New daemon PID $NEW_PID running, old PID $FIRST_PID cleaned up"
echo "TEST 15.2 PASSED: Optimistic cleanup working correctly"

# TEARDOWN
mcpli daemon clean
```

Expected Results:
- SETUP: Clean state, first daemon starts and expires naturally
- STALE STATE: Expired daemon leaves artifacts, stale files confirmed
- CLEANUP ACTION: New daemon startup triggers optimistic cleanup
- FINAL STATE: Only one daemon running, all stale artifacts removed

### 15.3) Long-lived daemon reuse verification

Test that multiple tool calls reuse the same daemon instance without spawning duplicates.

```bash
# SETUP: Ensure clean state
mcpli daemon clean
mcpli daemon status | grep "No daemons found" || { echo "SETUP FAIL: Existing daemons"; exit 1; }

# ACTION: Start daemon with long timeout
mcpli daemon start --timeout=300 -- node weather-server.js
ORIGINAL_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')

echo "SETUP: Original daemon PID: $ORIGINAL_PID"
test -n "$ORIGINAL_PID" || { echo "SETUP FAIL: No daemon started"; exit 1; }
kill -0 $ORIGINAL_PID || { echo "SETUP FAIL: Daemon not running"; exit 1; }

# ACTION: Make multiple tool calls and verify same daemon reuse
echo "Making 5 tool calls to verify daemon reuse..."
MISMATCH_COUNT=0
for i in {1..5}; do
  echo "Tool call $i:"
  mcpli get-weather --location "City$i" -- node weather-server.js >/dev/null
  CURRENT_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')
  LAST_ACCESS=$(mcpli daemon status | grep "Last access:" | awk '{print $3, $4}')
  
  # ASSERT: Same PID maintained
  if [ "$CURRENT_PID" = "$ORIGINAL_PID" ]; then
    echo "PASS: Same PID maintained: $CURRENT_PID (Last access: $LAST_ACCESS)"
  else
    echo "FAIL: PID changed from $ORIGINAL_PID to $CURRENT_PID"
    MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
  fi
  
  # ASSERT: Process still running
  kill -0 $CURRENT_PID || { echo "FAIL: Daemon process died"; exit 1; }
  
  sleep 1
done

# ASSERT FINAL STATE: Verify only one daemon throughout
FINAL_COUNT=$(mcpli daemon status | grep -c "Status: Running")
echo "ASSERT: $FINAL_COUNT daemons running after all tool calls"
test "$FINAL_COUNT" -eq 1 || { echo "FAIL: Expected 1 daemon, found $FINAL_COUNT"; exit 1; }

# ASSERT: No PID mismatches occurred
test "$MISMATCH_COUNT" -eq 0 || { echo "FAIL: $MISMATCH_COUNT PID mismatches detected"; exit 1; }

# ASSERT: No zombie processes
ZOMBIE_COUNT=$(ps aux | grep -v grep | grep weather-server | wc -l)
echo "ASSERT: $ZOMBIE_COUNT weather-server processes found"
test "$ZOMBIE_COUNT" -eq 1 || { echo "FAIL: Expected 1 process, found $ZOMBIE_COUNT"; exit 1; }

echo "TEST 15.3 PASSED: Long-lived daemon reuse working correctly"

# TEARDOWN
mcpli daemon clean
```

Expected Results:
- SETUP: Clean state, single daemon started with known PID
- REUSE TEST: All 5 tool calls use same daemon PID
- ACCESS TRACKING: Last access time updates with each call
- FINAL STATE: Exactly one daemon running, no duplicates or zombies

### 15.4) Daemon inactivity timer reset verification

Test that daemon timeout resets with activity (doesn't expire while in use).

```bash
# SETUP: Ensure clean state
mcpli daemon clean
mcpli daemon status | grep "No daemons found" || { echo "SETUP FAIL: Existing daemons"; exit 1; }

# ACTION: Start daemon with short timeout for testing (6 seconds)
mcpli daemon start --timeout=6 -- node weather-server.js
DAEMON_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')

echo "SETUP: Daemon PID: $DAEMON_PID with 6-second timeout"
test -n "$DAEMON_PID" || { echo "SETUP FAIL: No daemon started"; exit 1; }
kill -0 $DAEMON_PID || { echo "SETUP FAIL: Daemon not running"; exit 1; }

# ACTION: Keep daemon active with requests every 4 seconds (within timeout window)
DEATH_COUNT=0
for i in {1..3}; do
  echo "Activity cycle $i (at $(date +%H:%M:%S)) - sleeping 4 seconds then making request"
  sleep 4
  
  # Make request to reset timeout timer
  mcpli get-weather --location "Test$i" -- node weather-server.js >/dev/null
  
  # ASSERT: Same daemon still alive after activity
  CURRENT_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')
  if [ "$CURRENT_PID" = "$DAEMON_PID" ]; then
    echo "PASS: Daemon still alive with PID $CURRENT_PID - timeout reset by activity"
  else
    echo "FAIL: Daemon died or changed: $DAEMON_PID -> $CURRENT_PID"
    DEATH_COUNT=$((DEATH_COUNT + 1))
  fi
  
  kill -0 $DAEMON_PID || { echo "FAIL: Daemon process not running"; DEATH_COUNT=$((DEATH_COUNT + 1)); }
done

# ASSERT: Daemon should still be alive after activity cycles
test "$DEATH_COUNT" -eq 0 || { echo "FAIL: Daemon died $DEATH_COUNT times during activity"; exit 1; }
kill -0 $DAEMON_PID || { echo "FAIL: Daemon not running before inactivity test"; exit 1; }

# ACTION: Now let it timeout without activity (wait 8 seconds > 6 second timeout)
echo "TESTING: Letting daemon timeout without activity for 8 seconds..."
sleep 8

# ASSERT: Daemon should now be expired due to inactivity
kill -0 $DAEMON_PID 2>/dev/null && { echo "FAIL: Daemon should have timed out but still running"; exit 1; } || echo "PASS: Daemon timed out after inactivity"

mcpli daemon status | grep "No daemons found" || { echo "FAIL: Daemon status should show no daemons"; exit 1; }

echo "TEST 15.4 PASSED: Inactivity timer reset working correctly"
```

Expected Results:
- SETUP: Clean state, daemon started with 6-second timeout
- ACTIVITY TEST: 3 cycles of activity every 4 seconds keep daemon alive
- TIMEOUT PREVENTION: Timer resets prevent early termination during activity
- FINAL TIMEOUT: Daemon expires after 8 seconds of inactivity

### 15.5) Concurrent daemon timeout handling

Test timeout behavior when multiple daemons with different timeout values are running.

```bash
# SETUP: Ensure clean state
mcpli daemon clean
mcpli daemon status | grep "No daemons found" || { echo "SETUP FAIL: Existing daemons"; exit 1; }

# ACTION: Start multiple daemons with staggered timeouts (4, 8, 12 seconds)
echo "Starting 3 daemons with different timeouts..."
mcpli daemon start --timeout=4 -- node weather-server.js
mcpli daemon start --timeout=8 -- node test-server.js  
mcpli daemon start --timeout=12 -- node complex-test-server.js

# ASSERT INITIAL STATE: All 3 daemons running
INITIAL_COUNT=$(mcpli daemon status | grep -c "Status: Running")
echo "ASSERT: $INITIAL_COUNT daemons started"
test "$INITIAL_COUNT" -eq 3 || { echo "SETUP FAIL: Expected 3 daemons, got $INITIAL_COUNT"; exit 1; }

WEATHER_PID=$(mcpli daemon status | grep "weather-server" -A1 | grep "PID:" | awk '{print $2}')
TEST_PID=$(mcpli daemon status | grep "test-server" -A1 | grep "PID:" | awk '{print $2}')
COMPLEX_PID=$(mcpli daemon status | grep "complex-test-server" -A1 | grep "PID:" | awk '{print $2}')

echo "SETUP: Weather PID: $WEATHER_PID, Test PID: $TEST_PID, Complex PID: $COMPLEX_PID"

# ACTION: Wait and check timeouts in sequence
echo "Waiting 6 seconds - weather daemon (4s timeout) should expire..."
sleep 6

# ASSERT: First daemon expired, others alive
AFTER_6S=$(mcpli daemon status | grep -c "Status: Running")
echo "ASSERT: $AFTER_6S daemons running after 6 seconds"
kill -0 $WEATHER_PID 2>/dev/null && { echo "FAIL: Weather daemon should be expired"; exit 1; } || echo "PASS: Weather daemon expired"
kill -0 $TEST_PID || { echo "FAIL: Test daemon should still be running"; exit 1; }
kill -0 $COMPLEX_PID || { echo "FAIL: Complex daemon should still be running"; exit 1; }
test "$AFTER_6S" -eq 2 || { echo "FAIL: Expected 2 daemons after 6s, got $AFTER_6S"; exit 1; }

echo "Waiting 4 more seconds (10s total) - test daemon (8s timeout) should expire..."
sleep 4

# ASSERT: Second daemon expired, third alive
AFTER_10S=$(mcpli daemon status | grep -c "Status: Running")
echo "ASSERT: $AFTER_10S daemons running after 10 seconds"
kill -0 $TEST_PID 2>/dev/null && { echo "FAIL: Test daemon should be expired"; exit 1; } || echo "PASS: Test daemon expired"
kill -0 $COMPLEX_PID || { echo "FAIL: Complex daemon should still be running"; exit 1; }
test "$AFTER_10S" -eq 1 || { echo "FAIL: Expected 1 daemon after 10s, got $AFTER_10S"; exit 1; }

echo "Waiting 4 more seconds (14s total) - complex daemon (12s timeout) should expire..."
sleep 4

# ASSERT: All daemons expired
FINAL_COUNT=$(mcpli daemon status | grep -c "Status: Running" || echo "0")
echo "ASSERT: $FINAL_COUNT daemons running after 14 seconds"
kill -0 $COMPLEX_PID 2>/dev/null && { echo "FAIL: Complex daemon should be expired"; exit 1; } || echo "PASS: Complex daemon expired"
test "$FINAL_COUNT" -eq 0 || { echo "FAIL: Expected 0 daemons after 14s, got $FINAL_COUNT"; exit 1; }

mcpli daemon status | grep "No daemons found" || { echo "FAIL: Should show no daemons"; exit 1; }

echo "TEST 15.5 PASSED: Concurrent daemon timeouts working independently"
```

Expected Results:
- SETUP: 3 daemons started with 4s, 8s, 12s timeouts
- 6S MARK: Weather daemon (4s) expired, 2 remain
- 10S MARK: Test daemon (8s) expired, 1 remains  
- 14S MARK: Complex daemon (12s) expired, 0 remain
- INDEPENDENCE: Each timeout works without affecting others

### 15.6) Process cleanup verification

Test that terminated daemons properly clean up system resources.

```bash
# SETUP: Ensure clean state
mcpli daemon clean
mcpli daemon status | grep "No daemons found" || { echo "SETUP FAIL: Existing daemons"; exit 1; }

# ACTION: Start daemon and record all resource locations
mcpli daemon start --timeout=5 -- node weather-server.js
DAEMON_PID=$(mcpli daemon status | grep "PID:" | awk '{print $2}')
SOCKET_PATH=$(mcpli daemon status | grep "Socket:" | awk '{print $2}')
LOCK_PATH="${SOCKET_PATH%.sock}.lock"

echo "SETUP: Daemon PID: $DAEMON_PID"
echo "SETUP: Socket path: $SOCKET_PATH"  
echo "SETUP: Lock path: $LOCK_PATH"

test -n "$DAEMON_PID" || { echo "SETUP FAIL: No daemon PID"; exit 1; }
test -n "$SOCKET_PATH" || { echo "SETUP FAIL: No socket path"; exit 1; }

# ASSERT INITIAL STATE: All resources exist
kill -0 $DAEMON_PID || { echo "SETUP FAIL: Process not running"; exit 1; }
test -S "$SOCKET_PATH" || { echo "SETUP FAIL: Socket missing"; exit 1; }
test -f "$LOCK_PATH" || { echo "SETUP FAIL: Lock file missing"; exit 1; }
echo "ASSERT: All initial resources confirmed present"

# Get baseline process count
INITIAL_WEATHER_PROCS=$(ps aux | grep -v grep | grep weather-server.js | wc -l)
echo "SETUP: $INITIAL_WEATHER_PROCS weather-server processes initially"

# ACTION: Wait for daemon timeout (5 seconds + 2 second buffer)
echo "Waiting 7 seconds for daemon timeout and cleanup..."
sleep 7

# ASSERT COMPLETE CLEANUP: All resources should be gone
echo "ASSERTING: Complete resource cleanup after timeout"

# Process cleanup
kill -0 $DAEMON_PID 2>/dev/null && { echo "FAIL: Process $DAEMON_PID still exists"; exit 1; } || echo "PASS: Process cleaned up"

# File cleanup  
test -S "$SOCKET_PATH" && { echo "FAIL: Socket $SOCKET_PATH still exists"; exit 1; } || echo "PASS: Socket cleaned up"
test -f "$LOCK_PATH" && { echo "FAIL: Lock $LOCK_PATH still exists"; exit 1; } || echo "PASS: Lock cleaned up"

# Zombie process check
FINAL_WEATHER_PROCS=$(ps aux | grep -v grep | grep weather-server.js | wc -l)
echo "ASSERT: $FINAL_WEATHER_PROCS weather-server processes after cleanup"
test "$FINAL_WEATHER_PROCS" -eq 0 || { echo "FAIL: $FINAL_WEATHER_PROCS zombie processes remain"; exit 1; }

# Specific PID zombie check
ps aux | grep -v grep | grep "$DAEMON_PID" && { echo "FAIL: Zombie process $DAEMON_PID found"; exit 1; } || echo "PASS: No zombie process with PID $DAEMON_PID"

# Directory cleanup check
REMAINING_FILES=$(ls .mcpli/ 2>/dev/null | wc -l)
echo "ASSERT: $REMAINING_FILES files remaining in .mcpli/"
test "$REMAINING_FILES" -eq 0 || echo "INFO: $REMAINING_FILES files remain (expected if other tests ran)"

mcpli daemon status | grep "No daemons found" || { echo "FAIL: Status should show no daemons"; exit 1; }

echo "TEST 15.6 PASSED: Process cleanup working correctly"
```

Expected Results:
- SETUP: Daemon started with all resources (PID, socket, lock) confirmed
- INITIAL STATE: Process running, socket accessible, lock file present
- TIMEOUT ACTION: 7-second wait allows 5-second timeout + cleanup buffer
- COMPLETE CLEANUP: Process terminated, all files removed, no zombies

## 16) Cleanup

- Stop specific daemons:

```bash
mcpli daemon stop -- node weather-server.js
mcpli daemon stop -- node complex-test-server.js
```

- Or stop all daemons in this directory:

```bash
mcpli daemon stop
```

- Remove stale files and empty the `.mcpli` directory:

```bash
mcpli daemon clean
```

---

## Tips

- Add `--debug` for detailed diagnostics.
- Add `--verbose` to show MCP server stderr/logs when convenient.
- When testing fallback specifically, always provide the server command with `--` to enable stateless fallback.
- To produce daemon logs file, start with `--logs` (e.g., `mcpli daemon start --logs -- node weather-server.js`) and view with `mcpli daemon logs`.