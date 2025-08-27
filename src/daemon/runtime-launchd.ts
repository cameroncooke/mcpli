import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
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
} from './runtime.ts';

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
async function runLaunchctl(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const cp = spawn('launchctl', args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => (stdout += (d as Buffer).toString()));
    cp.stderr.on('data', (d) => (stderr += (d as Buffer).toString()));
    cp.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
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
  const label = labelFor(cwd, id);
  return path.join(plistDir(cwd), `${label}.plist`);
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
  return path.join(socketBase(cwd), `${id}.sock`);
}

/**
 * Minimal XML escaping for plist strings.
 */
function xmlEscape(value: string): string {
  return value.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
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
  logsPath?: string;
  machServices?: string[];
}): string {
  const {
    label,
    programArguments,
    workingDirectory,
    env,
    socketNameKey,
    socketPath,
    logsPath,
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

  const logsXml = logsPath
    ? `
  <key>StandardOutPath</key>
  <string>${xmlEscape(logsPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logsPath)}</string>`
    : '';

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
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('state =')) {
      // e.g., "state = running" or "state = waiting"
      if (/\brunning\b/i.test(trimmed)) {
        running = true;
      }
    }
    if (trimmed.startsWith('pid =')) {
      const num = parseInt(trimmed.split('=')[1].trim(), 10);
      if (!isNaN(num)) {
        pid = num;
      }
    }
  }
  return { running, pid };
}

/**
 * Bootstrap (load) a plist into the user's launchd domain.
 */
async function bootstrapPlist(plistFile: string): Promise<void> {
  const domain = userLaunchdDomain();
  const { code, stderr } = await runLaunchctl(['bootstrap', domain, plistFile]);
  if (code !== 0) {
    // If already loaded, print typically returns an error on bootstrap; we treat "service already loaded" as non-fatal.
    const loaded = await isLoaded(path.basename(plistFile, '.plist'));
    if (!loaded) {
      throw new Error(`launchctl bootstrap failed (code ${code}): ${stderr || 'Unknown error'}`);
    }
  }
}

/**
 * Boot out (unload) a label from the user's launchd domain.
 */
async function bootoutLabel(label: string): Promise<void> {
  const domain = userLaunchdDomain();
  await runLaunchctl(['bootout', `${domain}/${label}`]);
}

/**
 * Kickstart a job immediately (force start).
 */
async function kickstartLabel(label: string): Promise<void> {
  const domain = userLaunchdDomain();
  await runLaunchctl(['kickstart', '-k', `${domain}/${label}`]);
}

/**
 * Launchd-based orchestrator implementing dynamic, ephemeral jobs.
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
    const wrapperPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'daemon',
      'wrapper.js',
    );

    // Build environment for wrapper
    const logsPath = opts.logs ? path.join(cwd, '.mcpli', 'daemon.log') : undefined;
    const env: Record<string, string> = {
      MCPLI_ORCHESTRATOR: 'launchd',
      MCPLI_SOCKET_ENV_KEY: 'MCPLI_SOCKET',
      MCPLI_SOCKET_PATH: socketPath, // optional: for compatibility and diagnostics
      MCPLI_CWD: cwd,
      MCPLI_DEBUG: opts.debug ? '1' : '0',
      MCPLI_LOGS: opts.logs ? '1' : '0',
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
    };

    // Generate and write plist
    const plistContent = buildPlistXml({
      label,
      programArguments: [nodeExec, wrapperPath],
      workingDirectory: cwd,
      env,
      socketNameKey: 'MCPLI_SOCKET',
      socketPath,
      logsPath,
      // Remove machServices - not needed for socket activation
    });

    const pPath = this.plistPath(cwd, id);
    await writeFileAtomic(pPath, plistContent, 0o600);

    // Bootstrap if not loaded
    if (!(await isLoaded(label))) {
      await bootstrapPlist(pPath);
    }

    // Optionally start immediately
    if (opts.preferImmediateStart) {
      await kickstartLabel(label);
    }

    // Attempt to discover running state
    const { running, pid } = await getRunningState(label);

    return {
      id,
      label,
      socketPath,
      pid: running ? pid : undefined,
    };
  }

  /**
   * Stop a specific job by id, or all jobs under cwd if id omitted.
   */
  async stop(id?: string): Promise<void> {
    const cwd = process.cwd();
    if (id) {
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
      const idPart = label.split('.').pop();
      const idValue = idPart ?? '';
      const pPath = path.join(plistDir(cwd), fname);
      const sock = this.socketPathFor(cwd, idValue);

      await bootoutLabel(label).catch(() => {});
      await unlinkIfExists(pPath);
      await unlinkIfExists(sock);
    }
  }

  /**
   * List all orchestrator-managed jobs under cwd with status.
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
      const parts = label.split('.');
      const id = parts[parts.length - 1] || '';
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
  async clean(): Promise<void> {
    const cwd = process.cwd();
    // Stop all first
    await this.stop(cwd).catch(() => {});

    // Remove socket base directory if empty
    const base = socketBase(cwd);
    try {
      const files = await fs.readdir(base);
      for (const f of files) {
        if (f.endsWith('.sock')) {
          await unlinkIfExists(path.join(base, f));
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
          await unlinkIfExists(path.join(pdir, f));
        }
      }
      await fs.rmdir(pdir).catch(() => {});
    } catch {
      // ignore
    }
  }
}

export default LaunchdRuntime;
