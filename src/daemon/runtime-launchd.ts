import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  BaseOrchestrator,
  EnsureOptions,
  EnsureResult,
  Orchestrator,
  RuntimeStatus,
  deriveIdentityEnv,
  isValidDaemonId,
} from './runtime.ts';

/**
 * Validate daemon id and throw if invalid, including context for diagnostics.
 */
function assertValidDaemonId(id: string, ctx: string): void {
  if (!isValidDaemonId(id)) {
    throw new Error(`Invalid daemon id (${ctx}): "${id}"`);
  }
}

/**
 * Safely join a leaf file name under a base directory, ensuring no path traversal.
 * Note: We pass only validated leaf names without separators; this is defense-in-depth.
 */
function joinUnder(base: string, leafName: string): string {
  const resolvedBase = path.resolve(base);
  const joined = path.join(base, leafName);
  const resolvedJoined = path.resolve(joined);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (!resolvedJoined.startsWith(prefix)) {
    throw new Error(`Path traversal detected: "${leafName}"`);
  }
  return joined;
}

/**
 * Compute the label namespace prefix for the current working directory.
 * Format: "com.mcpli.<cwdHash>."
 */
function labelPrefixForCwd(cwd: string): string {
  return `com.mcpli.${hashCwd(cwd)}.`;
}

/**
 * Determine if a launchd label belongs to the current cwd's namespace and has a valid id.
 */
function isLabelForCwd(cwd: string, label: string): boolean {
  const prefix = labelPrefixForCwd(cwd);
  if (!label.startsWith(prefix)) return false;
  const id = label.slice(prefix.length);
  return isValidDaemonId(id);
}

/**
 * Extract the daemon id from a label if it belongs to the cwd namespace and is valid.
 */
function idFromLabelForCwd(cwd: string, label: string): string | undefined {
  const prefix = labelPrefixForCwd(cwd);
  if (!label.startsWith(prefix)) return undefined;
  const id = label.slice(prefix.length);
  return isValidDaemonId(id) ? id : undefined;
}

/**
 * Compute a short, stable hash for a working directory to scope labels/socket roots.
 */
function hashCwd(cwd: string): string {
  const abs = path.resolve(cwd || process.cwd());
  return createHash('sha256').update(abs).digest('hex').slice(0, 8);
}

/**
 * Ensure a directory exists with secure permissions.
 */
async function ensureDirSecure(dirPath: string, mode: number = 0o700): Promise<void> {
  if (!existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true, mode });
  }
  try {
    await fs.chmod(dirPath, mode);
  } catch {
    // Best effort
  }
}

/**
 * Atomic file write with secure permissions.
 */
async function writeFileAtomic(
  filePath: string,
  contents: string,
  mode: number = 0o600,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDirSecure(dir, 0o700);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, contents, { mode });
  await fs.rename(tmp, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // Ignore chmod errors
  }
}

/**
 * Write or update plist; if content changed and job is loaded, unload and reload.
 * Returns:
 *  - 'reloaded' when a loaded job was updated and reloaded,
 *  - 'loaded' when a previously-unloaded job was loaded,
 *  - 'unchanged' when no change was required.
 */
async function writeOrUpdatePlist(
  plistFile: string,
  contents: string,
  label: string,
): Promise<'reloaded' | 'loaded' | 'unchanged'> {
  const existed = existsSync(plistFile);
  let changed = true;
  if (existed) {
    try {
      const prev = await fs.readFile(plistFile, 'utf8');
      changed = prev !== contents;
    } catch {
      // Treat unreadable file as changed
      changed = true;
    }
  }

  if (!existed || changed) {
    await writeFileAtomic(plistFile, contents, 0o600);
    const wasLoaded = await isLoaded(label).catch(() => false);
    if (wasLoaded) {
      await bootoutLabel(label).catch(() => {});
    }
    await bootstrapPlist(plistFile);
    return wasLoaded ? 'reloaded' : 'loaded';
  } else {
    const loaded = await isLoaded(label).catch(() => false);
    if (!loaded) {
      await bootstrapPlist(plistFile);
      return 'loaded';
    }
    return 'unchanged';
  }
}

/**
 * Safe unlink - ignore ENOENT and other benign errors.
 */
async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

/**
 * launchctl subprocess runner
 */
/**
 * Run launchctl safely using an absolute path and robust error handling.
 * - Uses '/bin/launchctl' to avoid PATH lookups.
 * - Never rejects: resolves with a non-zero code and captured error message on failure.
 */
async function runLaunchctl(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    let resolved = false;
    const cp = spawn('/bin/launchctl', args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => (stdout += (d as Buffer).toString()));
    cp.stderr.on('data', (d) => (stderr += (d as Buffer).toString()));
    cp.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      resolve({ code: 127, stdout: '', stderr: String((err as Error)?.message ?? err) });
    });
    cp.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Return current per-user launchd domain (e.g., gui/501).
 */
function userLaunchdDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `gui/${uid}`;
}

/**
 * Label format: com.mcpli.<cwdHash>.<id>
 */
function labelFor(cwd: string, id: string): string {
  assertValidDaemonId(id, 'labelFor');
  return `com.mcpli.${hashCwd(cwd)}.${id}`;
}

/**
 * Plist storage directory under project.
 */
function plistDir(cwd: string): string {
  return path.join(cwd, '.mcpli', 'launchd');
}

/**
 * Plist full path for a label.
 */
function plistPath(cwd: string, id: string): string {
  assertValidDaemonId(id, 'plistPath');
  const label = labelFor(cwd, id);
  return joinUnder(plistDir(cwd), `${label}.plist`);
}

/**
 * Short socket base under tmpdir to avoid AF_UNIX path length issues.
 * Base: <tmp>/mcpli/<cwdHash>
 */
function socketBase(cwd: string): string {
  return path.join(os.tmpdir(), 'mcpli', hashCwd(cwd));
}

/**
 * Full socket path for a daemon id.
 */
function socketPathFor(cwd: string, id: string): string {
  assertValidDaemonId(id, 'socketPathFor');
  return joinUnder(socketBase(cwd), `${id}.sock`);
}

/**
 * Minimal XML escaping for plist strings.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a launchd plist XML string.
 */
function buildPlistXml(spec: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  env: Record<string, string>;
  socketNameKey: string; // environment key (e.g., MCPLI_SOCKET)
  socketPath: string;
  machServices?: string[];
}): string {
  const {
    label,
    programArguments,
    workingDirectory,
    env,
    socketNameKey,
    socketPath,
    machServices,
  } = spec;

  const envEntries = Object.entries(env);
  const progArgsXml = programArguments
    .map((s) => `      <string>${xmlEscape(s)}</string>`)
    .join('\n');

  const envXml =
    envEntries.length === 0
      ? ''
      : `
  <key>EnvironmentVariables</key>
  <dict>
${envEntries
  .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
  .join('\n')}
  </dict>`;

  const socketsXml = `
  <key>Sockets</key>
  <dict>
    <key>${xmlEscape(socketNameKey)}</key>
    <dict>
      <key>SockPathName</key>
      <string>${xmlEscape(socketPath)}</string>
      <key>SockPathMode</key>
      <integer>384</integer>
    </dict>
  </dict>`;

  // No log files - use OSLog instead for automatic cleanup
  const logsXml = '';

  const machServicesXml =
    machServices && machServices.length > 0
      ? `
  <key>MachServices</key>
  <dict>
${machServices.map((name) => `    <key>${xmlEscape(name)}</key>\n    <true/>`).join('\n')}
  </dict>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${progArgsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>${envXml}
${socketsXml}
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>${logsXml}${machServicesXml}
</dict>
</plist>`;
}

/**
 * Determine whether a launchd job is loaded (present in the domain).
 */
async function isLoaded(label: string): Promise<boolean> {
  const domain = userLaunchdDomain();
  const { code } = await runLaunchctl(['print', `${domain}/${label}`]);
  return code === 0;
}

/**
 * Parse 'launchctl print gui/<uid>/<label>' to extract running state and pid.
 */
async function getRunningState(label: string): Promise<{ running: boolean; pid?: number }> {
  const domain = userLaunchdDomain();
  const { code, stdout } = await runLaunchctl(['print', `${domain}/${label}`]);
  if (code !== 0) return { running: false };
  let running = false;
  let pid: number | undefined;
  let stateValue: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('state =')) {
      // e.g., "state = running" or "state = waiting"
      const val = trimmed.split('=')[1]?.trim().toLowerCase();
      stateValue = val;
      running = /\brunning\b/i.test(trimmed);
    }
    if (trimmed.startsWith('pid =')) {
      const num = parseInt(trimmed.split('=')[1].trim(), 10);
      if (!isNaN(num)) {
        pid = num;
      }
    }
  }
  // Some macOS versions may report state=running without a pid. Treat as not running.
  if (running && typeof pid !== 'number') {
    running = false;
  }
  // Also treat any non-"running" state as not running
  if (stateValue && stateValue !== 'running') {
    running = false;
  }
  return { running, pid };
}

/**
 * Bootstrap (load) a plist into the user's launchd domain.
 */
async function bootstrapPlist(plistFile: string): Promise<void> {
  const domain = userLaunchdDomain();
  const label = path.basename(plistFile, '.plist');
  const attempts = 3;
  let lastErr: string | undefined;

  for (let i = 0; i < attempts; i++) {
    const { code, stderr } = await runLaunchctl(['bootstrap', domain, plistFile]);
    if (code === 0) return;

    // If it is already loaded, consider success
    const loaded = await isLoaded(label).catch(() => false);
    if (loaded) return;

    lastErr = stderr || `code ${code}`;
    // Small backoff before retry (handle transient launchd races)
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }

  throw new Error(`launchctl bootstrap failed after retries: ${lastErr ?? 'Unknown error'}`);
}

/**
 * Boot out (unload) a label from the user's launchd domain.
 */
async function bootoutLabel(label: string): Promise<void> {
  const domain = userLaunchdDomain();
  await runLaunchctl(['bootout', `${domain}/${label}`]);
}

/**
 * Kickstart a job immediately (optionally kill+restart).
 */
async function kickstartLabel(label: string, opts: { kill?: boolean } = {}): Promise<void> {
  const domain = userLaunchdDomain();
  const args = ['kickstart'];
  if (opts.kill) args.push('-k');

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    const res = await runLaunchctl([...args, `${domain}/${label}`]);
    if (res.code === 0) return;
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  // Non-fatal: do not throw hard; let subsequent connection attempt activate on demand
  // but include a diagnostic for debugging if desired
  // throw new Error(`launchctl kickstart failed after retries (code ${last?.code}): ${last?.stderr || 'Unknown error'}`);
}

/**
 * Decide whether to kickstart and whether to kill a running job.
 * Policy:
 * - If preferImmediateStart is false: never start here (rely on socket-activation).
 * - If updateAction is 'loaded' or 'reloaded': start without kill.
 * - If updateAction is 'unchanged':
 *    - If not running: start without kill.
 *    - If running: do nothing.
 */
function shouldKickstart(
  preferImmediateStart: boolean,
  updateAction: 'loaded' | 'reloaded' | 'unchanged',
  running: boolean,
): { start: boolean; kill: boolean } {
  if (!preferImmediateStart) return { start: false, kill: false };
  if (updateAction === 'loaded' || updateAction === 'reloaded') {
    return { start: true, kill: false };
  }
  if (!running) {
    return { start: true, kill: false };
  }
  return { start: false, kill: false };
}

/**
 * Launchd-based orchestrator implementing dynamic, ephemeral jobs.
 */
/**
 * macOS launchd-based orchestrator. Manages per-project, per-command daemons
 * with socket activation and short, collision-safe socket paths.
 */
export class LaunchdRuntime extends BaseOrchestrator implements Orchestrator {
  readonly type = 'launchd' as const;

  /**
   * Compute job label for identity scoped to cwd.
   */
  private labelFor(cwd: string, id: string): string {
    return labelFor(cwd, id);
  }

  /**
   * Compute socket path for identity scoped to cwd (short path).
   */
  private socketPathFor(cwd: string, id: string): string {
    return socketPathFor(cwd, id);
  }

  /**
   * Compute plist path.
   */
  private plistPath(cwd: string, id: string): string {
    return plistPath(cwd, id);
  }

  /**
   * Ensure job artifacts exist and are bootstrapped in launchd.
   */
  /**
   * Ensure job artifacts exist and the job is bootstrapped in the user's
   * launchd domain. Optionally kickstarts the job based on policy.
   *
   * @param command Executable for the MCP server.
   * @param args Arguments to the MCP server executable.
   * @param opts Ensure options controlling env, cwd, and start policy.
   * @returns Ensure result with id, socket, label, and process details.
   */
  async ensure(command: string, args: string[], opts: EnsureOptions): Promise<EnsureResult> {
    const cwd = opts.cwd ?? process.cwd();
    const identityEnv = deriveIdentityEnv(opts.env ?? {});
    const id = this.computeId(command, args, identityEnv);
    const label = this.labelFor(cwd, id);
    const socketPath = this.socketPathFor(cwd, id);

    // Ensure directories
    await ensureDirSecure(path.join(cwd, '.mcpli'));
    await ensureDirSecure(plistDir(cwd));
    await ensureDirSecure(socketBase(cwd));

    // Build ProgramArguments
    const nodeExec = process.execPath; // absolute path to Node
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const wrapperPath = path.join(__dirname, 'daemon', 'wrapper.js');

    // Build environment for wrapper
    const wantLogs = Boolean(opts.logs ?? opts.verbose);
    // No log files - use OSLog instead for automatic cleanup
    // Base daemon environment (affects identity) - excludes MCPLI diagnostic flags
    const daemonEnv: Record<string, string> = {
      MCPLI_ORCHESTRATOR: 'launchd',
      MCPLI_SOCKET_ENV_KEY: 'MCPLI_SOCKET',
      MCPLI_SOCKET_PATH: socketPath, // optional: for compatibility and diagnostics
      MCPLI_CWD: cwd,
      MCPLI_TIMEOUT: String(
        typeof opts.timeoutMs === 'number' && !isNaN(opts.timeoutMs)
          ? opts.timeoutMs
          : typeof opts.timeout === 'number' && !isNaN(opts.timeout)
            ? opts.timeout * 1000
            : 1800000,
      ),
      MCPLI_COMMAND: command,
      MCPLI_ARGS: JSON.stringify(args),
      MCPLI_SERVER_ENV: JSON.stringify(opts.env ?? {}),
      MCPLI_ID_EXPECTED: id,
      // Add user's MCP server environment (from command spec after --)
      ...identityEnv,
    };

    // Write current diagnostic configuration to a file for the wrapper to read
    const diagnosticConfigPath = path.join(cwd, '.mcpli', `diagnostic-${id}.json`);
    const diagnosticConfig = {
      debug: Boolean(opts.debug),
      logs: Boolean(wantLogs),
      verbose: Boolean(opts.verbose),
      quiet: Boolean(opts.quiet),
    };
    await fs.writeFile(diagnosticConfigPath, JSON.stringify(diagnosticConfig), 'utf8');

    // Keep plist ProgramArguments constant - no diagnostic flags
    const wrapperArgs = [wrapperPath];

    // Generate and write plist
    const plistContent = buildPlistXml({
      label,
      programArguments: [nodeExec, ...wrapperArgs],
      workingDirectory: cwd,
      env: daemonEnv,
      socketNameKey: 'MCPLI_SOCKET',
      socketPath,
      // No log files - use OSLog instead
      // Remove machServices - not needed for socket activation
    });

    const pPath = this.plistPath(cwd, id);
    const updateAction = await writeOrUpdatePlist(pPath, plistContent, label);

    // Best-effort wait for launchd to (re)create the socket path after changes
    // to avoid brief ECONNREFUSED/ENOENT races during client connect.
    // This is a small poll for presence; it does not connect or block long.
    try {
      const fsP = await import('fs/promises');
      const deadline = Date.now() + 500; // up to 0.5s

      while (true) {
        try {
          await fsP.stat(socketPath);
          break;
        } catch {
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    } catch {
      // ignore
    }

    // Inspect current state
    let { running, pid } = await getRunningState(label);

    // Decide whether to kickstart (without kill by default) based on policy
    const { start, kill } = shouldKickstart(
      Boolean(opts.preferImmediateStart),
      updateAction,
      running,
    );
    let started = false;
    if (start) {
      await kickstartLabel(label, { kill });
      started = true;
      // Re-sample state to capture PID if it started
      const state = await getRunningState(label);
      running = state.running;
      pid = state.pid;
    }

    return {
      id,
      label,
      socketPath,
      pid: running ? pid : undefined,
      updateAction,
      started,
    };
  }

  /**
   * Stop a specific job by id, or all jobs under cwd if id omitted.
   */
  /**
   * Stop a specific job by id or all jobs for the current directory.
   *
   * @param id Optional daemon id. Stops all under cwd when omitted.
   * @returns A promise that resolves when stop actions complete.
   */
  async stop(id?: string): Promise<void> {
    const cwd = process.cwd();
    if (id) {
      assertValidDaemonId(id, 'stop(id)');
      const label = this.labelFor(cwd, id);
      const pPath = this.plistPath(cwd, id);
      const sock = this.socketPathFor(cwd, id);

      await bootoutLabel(label).catch(() => {});
      await unlinkIfExists(pPath);
      await unlinkIfExists(sock);
      return;
    }

    // Stop all jobs under this cwd
    let entries: string[] = [];
    try {
      entries = await fs.readdir(plistDir(cwd));
    } catch {
      return;
    }

    for (const fname of entries) {
      if (!fname.endsWith('.plist')) continue;
      const label = fname.slice(0, -6); // strip .plist
      if (!isLabelForCwd(cwd, label)) {
        // Skip entries that are not in our namespace or have invalid ids
        continue;
      }
      const idValue = idFromLabelForCwd(cwd, label)!;
      const pPath = joinUnder(plistDir(cwd), fname);
      const sock = this.socketPathFor(cwd, idValue);

      await bootoutLabel(label).catch(() => {});
      await unlinkIfExists(pPath);
      await unlinkIfExists(sock);
    }
  }

  /**
   * List all orchestrator-managed jobs under cwd with status.
   */
  /**
   * List all launchd jobs managed under the current directory with status.
   *
   * @returns Array of status entries for this cwd.
   */
  async status(): Promise<RuntimeStatus[]> {
    const cwd = process.cwd();
    const results: RuntimeStatus[] = [];
    let entries: string[] = [];
    try {
      entries = await fs.readdir(plistDir(cwd));
    } catch {
      return results;
    }

    for (const fname of entries) {
      if (!fname.endsWith('.plist')) continue;
      const label = fname.slice(0, -6);
      if (!isLabelForCwd(cwd, label)) continue;
      const id = idFromLabelForCwd(cwd, label)!;
      const socketPath = this.socketPathFor(cwd, id);

      const loaded = await isLoaded(label).catch(() => false);
      let running = false;
      let pid: number | undefined;

      if (loaded) {
        const state = await getRunningState(label).catch(
          (): { running: false; pid?: undefined } => ({ running: false as const }),
        );
        running = state.running;
        pid = state.pid;
      }

      results.push({
        id,
        label,
        loaded,
        running,
        pid,
        socketPath,
      });
    }

    return results;
  }

  /**
   * Clean all artifacts (jobs, plists, sockets) under cwd.
   */
  /**
   * Remove all artifacts (jobs, plists, sockets) under the current directory.
   *
   * @returns A promise that resolves when cleanup completes.
   */
  async clean(): Promise<void> {
    const cwd = process.cwd();
    // Stop all first
    await this.stop().catch(() => {});

    // Remove socket base directory if empty
    const base = socketBase(cwd);
    try {
      const files = await fs.readdir(base);
      for (const f of files) {
        if (f.endsWith('.sock')) {
          await unlinkIfExists(joinUnder(base, f));
        }
      }
      // attempt to remove the directory tree
      await fs.rmdir(base).catch(async () => {
        // Try removing parent tmp/mcpli/<cwdHash> directory only; ignore failures
      });
    } catch {
      // ignore
    }

    // Remove plist directory if empty
    const pdir = plistDir(cwd);
    try {
      const files = await fs.readdir(pdir);
      for (const f of files) {
        if (f.endsWith('.plist')) {
          await unlinkIfExists(joinUnder(pdir, f));
        }
      }
      await fs.rmdir(pdir).catch(() => {});
    } catch {
      // ignore
    }
  }
}

export default LaunchdRuntime;
