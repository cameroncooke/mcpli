# MCPLI Daemon System – Manual Testing Guide

This document provides practical, copy‑pasteable steps to manually verify MCPLI’s daemon system:

- Automatic daemon management
- No duplicate spawning for the same command + args
- Default daemon usage (no `--` command needed after the first run)
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

## 3) Default daemon usage (no `--` command after first run)

After the daemon exists for a command, MCPLI allows calling tools without specifying the server command.

- Call the weather tool without a server command:

```bash
mcpli get-weather --location "Seattle"
```

Expected:
- It connects to the already running daemon and returns weather data.
- This confirms "default daemon" behavior is working.

If no daemon is running yet, you will see:
- `Error: No daemon running and MCP server command not provided`
- This is expected when you haven’t started the daemon yet (either via a tool call with `-- <server command>` or `mcpli daemon start -- <server command>`).

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

- After the first run, omit `-- node weather-server.js` (uses default daemon):

```bash
mcpli get-weather --location "Austin, TX"
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

## 11) Cleanup

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