#!/usr/bin/env node

/**
 * MCPLI - Turn any MCP server into a first-class CLI tool.
 *
 * CLI entrypoint: parses arguments, ensures a per-command daemon via the
 * orchestrator, and forwards tool invocations over secure local IPC.
 */

import { DaemonClient } from './daemon/index.ts';
import { Tool, ToolCallResult } from './daemon/ipc.ts';
import {
  handleDaemonStart,
  handleDaemonStop,
  handleDaemonStatus,
  handleDaemonRestart,
  handleDaemonClean,
  handleDaemonLogs,
  printDaemonHelp,
} from './daemon/index.ts';
import { getConfig } from './config.ts';
import { isUnsafeKey, safeEmptyRecord, safeDefine, deepSanitize } from './utils/safety.ts';
import path from 'path';
import { spawn } from 'child_process';

/**
 * Global CLI flags that shape daemon behavior and output.
 */
interface GlobalOptions {
  /** Show help text instead of executing. */
  help?: boolean;
  /** Suppress non-essential output. */
  quiet?: boolean;
  /** Print raw MCP response JSON. */
  raw?: boolean;
  /** Enable debug diagnostics. */
  debug?: boolean;
  /** Show live daemon logs when executing. */
  verbose?: boolean;
  /** Inactivity timeout (seconds) for daemon. */
  timeout?: number;
  /** Default tool execution timeout (seconds). */
  toolTimeoutSeconds?: number;
  /** Internal: daemon subcommand mode. */
  daemon?: boolean;
}

// -----------------------------------------------------------------------------
// Command specification (ENV VARS + command + args) utilities
// -----------------------------------------------------------------------------

type CommandSpec = {
  /** Environment variables passed to the MCP server process. */
  env: Record<string, string>;
  /** Executable to run for the MCP server. */
  command: string;
  /** Arguments to pass to the MCP server. */
  args: string[];
};

/**
 * Parse KEY=VALUE pairs and a command following `--` into a CommandSpec.
 *
 * @param tokens CLI tokens after `--` containing env, command and args.
 * @returns A parsed command, args, and env spec.
 */
function parseCommandSpec(tokens: string[]): CommandSpec {
  const env = safeEmptyRecord<string>();
  let i = 0;
  const envPattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

  while (i < tokens.length && envPattern.test(tokens[i])) {
    const match = envPattern.exec(tokens[i]);
    if (match) {
      const key = match[1];
      const value = match[2];
      if (isUnsafeKey(key)) {
        throw new Error(`Unsafe environment variable name "${key}" is not allowed.`);
      }
      safeDefine(env as unknown as Record<string, unknown>, key, value);
      i++;
      continue;
    }
    break;
  }

  const command = tokens[i];
  const args = tokens.slice(i + 1);

  if (!command) {
    throw new Error('Command required after --');
  }

  return { env, command, args };
}

/**
 * Parse CLI argv into global flags, user tool args, and CommandSpec fields
 * (child command/args/env) when present after `--`.
 *
 * @param argv Full process argv array.
 * @returns Parsed globals, child command/args/env, user args and daemon subcommand fields.
 */
function parseArgs(argv: string[]): {
  globals: GlobalOptions;
  childCommand: string;
  childArgs: string[];
  childEnv: Record<string, string>;
  userArgs: string[];
  daemonCommand?: string;
  daemonArgs?: string[];
} {
  const args = argv.slice(2); // Remove node and script name
  const config = getConfig();
  const globals: GlobalOptions = { timeout: config.defaultTimeoutSeconds };

  // ---------------------------------------------------------------------------
  // Daemon mode
  // ---------------------------------------------------------------------------
  if (args[0] === 'daemon') {
    globals.daemon = true;

    // daemon --help
    if (args[1] === '--help' || args[1] === '-h') {
      globals.help = true;
      return {
        globals,
        daemonCommand: '',
        daemonArgs: [],
        childCommand: '',
        childArgs: [],
        childEnv: {},
        userArgs: [],
      };
    }

    const daemonCommand = args[1];
    const daemonArgs = args.slice(2);

    // Parse daemon-specific options
    for (const arg of daemonArgs) {
      if (arg === '--help' || arg === '-h') globals.help = true;
      else if (arg === '--quiet' || arg === '-q') globals.quiet = true;
      else if (arg === '--debug') globals.debug = true;
      else if (arg === '--verbose') globals.verbose = true;
      else if (arg.startsWith('--timeout=')) {
        globals.timeout = parseInt(arg.split('=')[1], 10);
      } else if (arg.startsWith('--tool-timeout=')) {
        globals.toolTimeoutSeconds = parseInt(arg.split('=')[1], 10);
      }
    }

    return {
      globals,
      daemonCommand,
      daemonArgs,
      childCommand: '',
      childArgs: [],
      childEnv: {},
      userArgs: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Regular execution mode
  // ---------------------------------------------------------------------------
  const dashIndex = args.indexOf('--');

  // No -- separator present
  if (dashIndex === -1) {
    // Help requested or zero args
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
      return {
        globals: { ...globals, help: true },
        childCommand: '',
        childArgs: [],
        childEnv: {},
        userArgs: args,
      };
    }

    // Attempt daemon-only mode when no --
    return {
      globals,
      childCommand: '',
      childArgs: [],
      childEnv: {},
      userArgs: args,
    };
  }

  // Parse everything after --
  const afterDash = args.slice(dashIndex + 1);
  let childEnv: Record<string, string> = safeEmptyRecord<string>();
  let childCommand = '';
  let childArgs: string[] = [];

  try {
    const spec = parseCommandSpec(afterDash);
    childEnv = spec.env;
    childCommand = spec.command;
    childArgs = spec.args;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  const userArgs = args.slice(0, dashIndex);

  if (!childCommand) {
    console.error('Error: Child command required after --');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Parse global flags (before --)
  // ---------------------------------------------------------------------------
  let foundToolName = false;
  for (const arg of userArgs) {
    if (!arg.startsWith('--') && !arg.startsWith('-') && !foundToolName) {
      foundToolName = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      if (!foundToolName) globals.help = true;
    } else if (arg === '--raw') globals.raw = true;
    else if (arg === '--debug') globals.debug = true;
    else if (arg === '--verbose') globals.verbose = true;
    else if (arg.startsWith('--timeout=')) {
      globals.timeout = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--tool-timeout=')) {
      globals.toolTimeoutSeconds = parseInt(arg.split('=')[1], 10);
    }
  }

  return { globals, childCommand, childArgs, childEnv, userArgs };
}

// -----------------------------------------------------------------------------
// Env-aware tool discovery (daemon mode)
// -----------------------------------------------------------------------------
/**
 * Ensure/connect to daemon and fetch tools, returning the client and a
 * no-op close function for symmetry.
 *
 * @param command MCP server executable.
 * @param args Arguments for the MCP server.
 * @param env Environment for the MCP server.
 * @param options Global options relevant to discovery.
 * @returns Tools available and a connected client handle.
 */
async function discoverToolsEx(
  command: string,
  args: string[],
  env: Record<string, string>,
  options: GlobalOptions,
): Promise<{
  tools: Tool[];
  daemonClient: DaemonClient;
  close: () => Promise<void>;
}> {
  if (!command) {
    throw new Error('Server command is required');
  }

  const daemonClient = new DaemonClient(command, args, {
    verbose: options.verbose,
    debug: options.debug,
    timeout: options.timeout, // Pass timeout in seconds, let DaemonClient handle conversion
    toolTimeoutMs:
      typeof options.toolTimeoutSeconds === 'number' && !isNaN(options.toolTimeoutSeconds)
        ? Math.max(1, Math.trunc(options.toolTimeoutSeconds)) * 1000
        : undefined,
    env,
  });

  const result = await daemonClient.listTools();
  return {
    tools: result.tools || [],
    daemonClient,
    close: () => Promise.resolve(),
  };
}

/**
 * Normalize tool name for matching (lowercase alnum only).
 *
 * @param name Tool name to normalize.
 * @returns Normalized token for matching.
 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Identify the selected tool from the first non-option argument.
 *
 * @param userArgs CLI arguments entered by the user.
 * @param tools Tools discovered from the daemon.
 * @returns The matched tool and the token used, or null if none.
 */
function findTool(userArgs: string[], tools: Tool[]): { tool: Tool; toolName: string } | null {
  const toolMap = new Map<string, Tool>();

  // Build tool index
  for (const tool of tools) {
    const name = tool.name;
    toolMap.set(name, tool);
    toolMap.set(name.replace(/_/g, '-'), tool);
    toolMap.set(normalizeToolName(name), tool);
  }

  // Look for tool selection - first non-option argument is the tool name
  for (const arg of userArgs) {
    if (!arg.startsWith('--') && !arg.startsWith('-')) {
      const normalizedArg = normalizeToolName(arg);
      const variants = [arg, arg.replace(/_/g, '-'), normalizedArg];
      for (const key of variants) {
        if (toolMap.has(key)) {
          const tool = toolMap.get(key);
          if (tool) return { tool, toolName: arg };
        }
      }
    }
  }

  return null;
}

/**
 * Parse user-provided tool parameters according to the tool's input schema,
 * coercing types and sanitizing JSON where applicable.
 *
 * @param userArgs CLI arguments including tool options.
 * @param selectedTool The tool definition with input schema.
 * @param toolName The user-entered tool token used to find parameters.
 * @returns A parameter object ready to send to the daemon.
 */
function parseParams(
  userArgs: string[],
  selectedTool: Tool,
  toolName: string,
): Record<string, unknown> {
  const params = safeEmptyRecord<unknown>();
  const schema =
    (selectedTool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};

  // Find the start of parameters for the selected tool
  const toolNameIndex = userArgs.indexOf(toolName);
  if (toolNameIndex === -1) {
    // This should not happen if findTool worked correctly, but as a safeguard.
    return {};
  }

  const paramArgs = userArgs.slice(toolNameIndex + 1);
  const args: { key: string; value: string | boolean }[] = [];

  // Phase 1: Tokenize arguments into a structured list of key-value pairs
  for (let i = 0; i < paramArgs.length; i++) {
    const arg = paramArgs[i];
    let key: string | undefined;
    let value: string | boolean | undefined;

    if (arg.startsWith('--')) {
      if (arg.includes('=')) {
        const parts = arg.split('=', 2);
        key = parts[0].slice(2);
        value = parts[1];
      } else {
        key = arg.slice(2);
        const nextArg = paramArgs[i + 1];
        if (nextArg && (!nextArg.startsWith('-') || !isNaN(Number(nextArg)))) {
          value = nextArg;
          i++; // Consume value argument
        } else {
          value = true; // It's a boolean flag
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2 && isNaN(Number(arg[1]))) {
      // Handle short-form arguments like -f (but not negative numbers like -5)
      key = arg.slice(1);
      const nextArg = paramArgs[i + 1];
      if (nextArg && (!nextArg.startsWith('-') || !isNaN(Number(nextArg)))) {
        value = nextArg;
        i++; // Consume value argument
      } else {
        value = true; // It's a boolean flag
      }
    }

    if (key !== undefined && value !== undefined) {
      if (isUnsafeKey(key)) {
        throw new Error(`Unsafe parameter name "${key}" is not allowed.`);
      }
      args.push({ key, value });
    }
    // Non-option arguments (positional) are ignored for now
  }

  // Phase 2: Parse and convert values based on the tool's inputSchema
  for (const { key, value } of args) {
    const propSchema = schema[key] as { type?: string } | undefined;

    if (!propSchema) {
      // If no schema is found for this param, make a best effort to parse
      if (value === true) {
        safeDefine(params, key, true);
      } else {
        try {
          const parsed: unknown = JSON.parse(value as string);
          safeDefine(params, key, deepSanitize(parsed));
        } catch {
          safeDefine(params, key, value);
        }
      }
      continue;
    }

    // Handle boolean type specifically, as it can be a flag or have a value
    if (propSchema.type === 'boolean') {
      if (value === true) {
        safeDefine(params, key, true);
        continue;
      }
      const strValue = String(value).toLowerCase();
      if (strValue === 'true') {
        safeDefine(params, key, true);
      } else if (strValue === 'false') {
        safeDefine(params, key, false);
      } else {
        throw new Error(
          `Argument --${key} expects a boolean (true/false), but received "${value}".`,
        );
      }
      continue;
    }

    // For all other types, a valueless flag is an error
    if (value === true) {
      throw new Error(
        `Argument --${key} of type "${propSchema.type ?? 'unknown'}" requires a value.`,
      );
    }

    const strValue = value as string;

    switch (propSchema.type) {
      case 'string':
        safeDefine(params, key, strValue);
        break;
      case 'number':
      case 'integer': {
        const num = Number(strValue);
        if (isNaN(num) || strValue.trim() === '') {
          throw new Error(
            `Argument --${key} expects a ${propSchema.type}, but received "${strValue}".`,
          );
        }
        if (propSchema.type === 'integer' && !Number.isInteger(num)) {
          throw new Error(`Argument --${key} expects an integer, but received "${strValue}".`);
        }
        safeDefine(params, key, num);
        break;
      }
      case 'array':
      case 'object':
        try {
          const parsed: unknown = JSON.parse(strValue);
          safeDefine(params, key, deepSanitize(parsed));
        } catch (e) {
          throw new Error(
            `Argument --${key} expects a valid JSON ${propSchema.type}. Parse error: ${e instanceof Error ? e.message : String(e)} on input: "${strValue}"`,
          );
        }
        break;
      case 'null':
        if (strValue.toLowerCase() !== 'null') {
          throw new Error(`Argument --${key} expects null, but received "${strValue}".`);
        }
        safeDefine(params, key, null);
        break;
      default:
        // Fallback for schemas with anyOf, oneOf, or no type property.
        try {
          const parsed: unknown = JSON.parse(strValue);
          safeDefine(params, key, deepSanitize(parsed));
        } catch {
          safeDefine(params, key, strValue);
        }
    }
  }

  return params;
}

/**
 * Extract a convenient payload from an MCP ToolCallResult for CLI printing.
 *
 * @param result The raw ToolCallResult from the daemon.
 * @returns A primitive or object suitable for printing.
 */
function extractContent(result: ToolCallResult): unknown {
  if (!result.content || result.content.length === 0) {
    return null;
  }

  if (result.content.length === 1) {
    const item = result.content[0];
    if (item.type === 'text') {
      try {
        return JSON.parse(item.text ?? '') as unknown;
      } catch {
        return item.text ?? '';
      }
    }
    return JSON.stringify(item);
  }

  return result.content.map((item) => {
    if (item.type === 'text') {
      try {
        return JSON.parse(item.text ?? '') as unknown;
      } catch {
        return item.text ?? '';
      }
    }
    return JSON.stringify(item);
  });
}

/**
 * Build a printable command string from a CommandSpec-like shape for help/UX.
 *
 * @param actualCommand Command, args, and env to display.
 * @returns A CLI string for documentation.
 */
function buildCommandString(actualCommand?: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}): string {
  if (!actualCommand?.command) {
    return 'node server.js';
  }

  const envStr =
    actualCommand.env && Object.keys(actualCommand.env).length > 0
      ? Object.entries(actualCommand.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') + ' '
      : '';
  const argsStr =
    actualCommand.args && actualCommand.args.length > 0 ? ' ' + actualCommand.args.join(' ') : '';
  return `${envStr}${actualCommand.command}${argsStr}`;
}

/**
 * Tail the daemon log file live when `--verbose` is set. Non-fatal on errors.
 *
 * @param cwd The working directory where `.mcpli/daemon.log` lives.
 * @returns An object with `stop()` to end log following.
 */
function spawnLiveLogFollower(cwd: string): { stop: () => void } {
  const logPath = path.join(cwd, '.mcpli', 'daemon.log');
  // Use absolute path to tail for safety and predictability (no PATH lookup)
  const proc = spawn('/usr/bin/tail', ['-n', '0', '-F', logPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  proc.on('error', (err) => {
    // Non-fatal: continue without live log tailing
    console.error(
      `[WARN] Failed to start live log follower: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (!proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 500);
    }
  };

  process.once('exit', stop);
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stop();
  });

  return { stop };
}

/**
 * Print detailed help for a specific tool based on its inputSchema.
 *
 * @param tool The tool to document.
 * @param actualCommand Optional command context for example strings.
 * @returns Nothing; prints to stdout.
 */
function printToolHelp(
  tool: Tool,
  actualCommand?: { command?: string; args?: string[]; env?: Record<string, string> },
): void {
  console.log(`MCPLI Tool: ${tool.name}`);
  console.log('');
  if (tool.description) {
    console.log(`Description: ${tool.description}`);
    console.log('');
  }

  console.log(`Usage: mcpli ${tool.name} [options] -- <mcp-server-command> [args...]`);
  console.log('');

  if (tool.inputSchema?.properties) {
    console.log('Options:');
    const properties = tool.inputSchema.properties;
    const required = tool.inputSchema.required ?? [];

    for (const [propName, propSchema] of Object.entries(properties)) {
      const schema = propSchema as Record<string, unknown>;
      const isRequired = (required as string[]).includes(propName);
      const type = (schema.type as string) ?? 'string';
      const description = (schema.description as string) ?? '';
      const defaultValue = schema.default;

      let line = `  --${propName.padEnd(20)}`;
      if (type) line += ` (${type})`;
      if (isRequired) line += ' [required]';
      if (description) line += ` ${description}`;
      if (defaultValue !== undefined) line += ` (default: ${JSON.stringify(defaultValue)})`;

      console.log(line);
    }
    console.log('');
  }

  console.log('Examples:');
  const exampleName = tool.name.replace(/_/g, '-');
  const commandStr = buildCommandString(actualCommand);

  console.log(`  mcpli ${exampleName} --help -- ${commandStr}`);

  if (tool.inputSchema?.properties) {
    const properties = Object.keys(tool.inputSchema.properties);
    if (properties.length > 0) {
      const firstProp = properties[0];
      console.log(`  mcpli ${exampleName} --${firstProp} "example-value" -- ${commandStr}`);
    }
  }
}

/**
 * Print top-level CLI help, including discovered tools and daemon commands.
 *
 * @param tools Tools discovered from the daemon.
 * @param specificTool Optional tool for detailed help when provided.
 * @param actualCommand Optional command context for example strings.
 * @returns Nothing; prints to stdout.
 */
function printHelp(
  tools: Tool[],
  specificTool?: Tool,
  actualCommand?: { command?: string; args?: string[]; env?: Record<string, string> },
): void {
  if (specificTool) {
    printToolHelp(specificTool, actualCommand);
    return;
  }

  console.log('MCPLI - Turn any MCP server into a first-class CLI tool');
  console.log('');
  console.log('Usage:');
  console.log('  mcpli <tool> [tool-options...] -- <mcp-server-command> [args...]');
  console.log('  mcpli <tool> --help -- <mcp-server-command> [args...]');
  console.log('  mcpli --help -- <mcp-server-command> [args...]');
  console.log('  mcpli daemon <subcommand> [options]');
  console.log('');
  console.log('Global Options:');
  console.log('  --help, -h     Show this help and list all available tools');
  console.log('  --verbose      Show MCP server output (stderr/logs)');
  console.log('  --raw          Print raw MCP response');
  console.log('  --debug        Enable debug output');

  const config = getConfig();
  console.log(
    `  --timeout=<seconds> Set daemon inactivity timeout (default: ${config.defaultTimeoutSeconds})`,
  );
  // Tool execution timeout (front-facing). Show seconds for consistency with --timeout
  const defaultToolSecs = Math.trunc(config.defaultToolTimeoutMs / 1000);
  console.log(
    `  --tool-timeout=<seconds> Set tool execution timeout (default: ${defaultToolSecs})`,
  );
  console.log('');
  console.log('Related env vars:');
  console.log('  MCPLI_IPC_TIMEOUT (ms), MCPLI_TOOL_TIMEOUT_MS (ms)');
  console.log('');

  if (tools.length > 0) {
    console.log('Available Tools:');
    for (const tool of tools) {
      const name = tool.name.replace(/_/g, '-');
      const desc = tool.description ?? 'No description';
      console.log(`  ${name.padEnd(20)} ${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}`);
    }
    console.log('');
    console.log('Tool Help:');
    console.log(
      `  mcpli <tool> --help -- <mcp-server-command>    Show detailed help for specific tool`,
    );
    console.log('');
  }

  console.log('Daemon Commands:');
  console.log('  daemon start   Start long-lived daemon process');
  console.log('  daemon stop    Stop daemon process');
  console.log('  daemon status  Show daemon status');
  console.log('  daemon restart Restart daemon process');
  console.log('  daemon logs    Show daemon logs');
  console.log('  daemon clean   Clean up daemon files');
  console.log('');

  if (tools.length > 0) {
    const commandStr = buildCommandString(actualCommand);

    console.log('Examples:');
    console.log(`  mcpli ${tools[0].name.replace(/_/g, '-')} --help -- ${commandStr}`);
    console.log(`  mcpli ${tools[0].name.replace(/_/g, '-')} --option value -- ${commandStr}`);
    console.log('');
  } else {
    console.log('No tools found. The MCP server may not be responding correctly.');
    console.log('');
    console.log('Examples:');
    console.log('  mcpli --help -- node server.js       # Show tools from server.js');
    console.log('  mcpli daemon start -- node server.js # Start long-lived daemon');
  }
}

/**
 * CLI main: parse args, ensure daemon, execute tool, and render output.
 *
 * @returns A promise that resolves when the CLI run completes.
 */
async function main(): Promise<void> {
  try {
    const result = parseArgs(process.argv);
    const { globals } = result;

    if (globals.debug) {
      console.log('[DEBUG] Parsed args:', result);
    }

    // Handle daemon subcommands
    if (globals.daemon) {
      const { daemonCommand, daemonArgs } = result as typeof result & {
        daemonCommand?: string;
        daemonArgs: string[];
      };

      if (globals.help || !daemonCommand) {
        printDaemonHelp();
        return;
      }

      const options = {
        debug: globals.debug,
        timeout: globals.timeout, // Pass seconds, getDaemonTimeoutMs will be called in commands.ts
        quiet: globals.quiet,
        toolTimeoutMs:
          typeof globals.toolTimeoutSeconds === 'number' && !isNaN(globals.toolTimeoutSeconds)
            ? Math.max(1000, Math.trunc(globals.toolTimeoutSeconds) * 1000)
            : undefined,
      };

      switch (daemonCommand) {
        case 'start': {
          const dashIndex = daemonArgs.indexOf('--');
          if (dashIndex === -1) {
            console.error('Error: Command required after -- for daemon start');
            console.error('Usage: mcpli daemon start -- [KEY=VALUE...] <command> [args...]');
            process.exit(1);
          }
          let spec;
          try {
            spec = parseCommandSpec(daemonArgs.slice(dashIndex + 1));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Error: ${msg}`);
            process.exit(1);
          }
          const command = spec.command;
          const args = spec.args;
          const env = spec.env;
          if (!command) {
            console.error('Error: Command required after --');
            process.exit(1);
          }
          await handleDaemonStart(command, args, { ...options, env });
          break;
        }

        case 'stop': {
          const stopDashIndex = daemonArgs.indexOf('--');
          if (stopDashIndex !== -1) {
            let spec;
            try {
              spec = parseCommandSpec(daemonArgs.slice(stopDashIndex + 1));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`Error: ${msg}`);
              process.exit(1);
            }
            await handleDaemonStop(spec.command, spec.args, { ...options, env: spec.env });
          } else {
            await handleDaemonStop(undefined, [], options);
          }
          break;
        }

        case 'status':
          await handleDaemonStatus();
          break;

        case 'restart': {
          const restartDashIndex = daemonArgs.indexOf('--');
          if (restartDashIndex !== -1) {
            let spec;
            try {
              spec = parseCommandSpec(daemonArgs.slice(restartDashIndex + 1));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`Error: ${msg}`);
              process.exit(1);
            }
            await handleDaemonRestart(spec.command, spec.args, { ...options, env: spec.env });
          } else {
            await handleDaemonRestart(undefined, [], options);
          }
          break;
        }

        case 'logs': {
          const logsDashIndex = daemonArgs.indexOf('--');
          if (logsDashIndex !== -1) {
            let spec;
            try {
              spec = parseCommandSpec(daemonArgs.slice(logsDashIndex + 1));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`Error: ${msg}`);
              process.exit(1);
            }
            await handleDaemonLogs(spec.command, spec.args, { ...options, env: spec.env });
          } else {
            await handleDaemonLogs();
          }
          break;
        }

        case 'clean': {
          await handleDaemonClean(options);
          break;
        }

        default:
          console.error(`Error: Unknown daemon command: ${daemonCommand}`);
          console.error('Use "mcpli daemon --help" to see available commands');
          process.exit(1);
      }

      return;
    }

    // Regular tool execution mode
    const { childCommand, childArgs, childEnv, userArgs } = result;

    // No error for missing childCommand - we'll try daemon mode first

    // Show help for regular mode
    if (globals.help) {
      if (childCommand) {
        // Get tools to show in help - always discover tools for root help
        try {
          const { tools, close } = await discoverToolsEx(
            childCommand,
            childArgs,
            childEnv ?? {},
            globals,
          );
          printHelp(tools, undefined, { command: childCommand, args: childArgs, env: childEnv });
          await close();
        } catch (error) {
          console.error(
            `Error connecting to MCP server: ${error instanceof Error ? error.message : error}`,
          );
          console.error('Cannot show available tools. Please check your MCP server command.');
          printHelp([]);
        }
      } else {
        // Try daemon mode for help - discover tools from running daemon
        try {
          const { tools, close } = await discoverToolsEx('', [], {}, globals);
          printHelp(tools);
          await close();
        } catch {
          console.error('Error: No daemon running and MCP server command not provided');
          console.error('Usage: mcpli --help -- <mcp-server-command> [args...]');
          console.error('Example: mcpli --help -- node server.js');
          printHelp([]);
        }
      }
      return;
    }

    if (globals.debug) {
      console.log('[DEBUG] Tool execution mode:', {
        childCommand,
        childArgs,
        userArgs,
        env: childEnv || {},
      });
    }

    // Discover tools
    if (globals.debug) {
      console.time('[DEBUG] Daemon connection & tool discovery');
    }
    const { tools, daemonClient, close } = await discoverToolsEx(
      childCommand,
      childArgs,
      childEnv || {},
      globals,
    );
    if (globals.debug) {
      console.timeEnd('[DEBUG] Daemon connection & tool discovery');
    }

    if (globals.debug) {
      console.error(
        '[DEBUG] Found tools:',
        tools.map((t: Tool) => t.name),
      );
      console.log('[DEBUG] Using daemon: true');
    }

    // Show help if no tool specified
    if (userArgs.length === 0) {
      printHelp(tools, undefined, { command: childCommand, args: childArgs, env: childEnv });
      await close();
      return;
    }

    // Find selected tool
    const toolResult = findTool(userArgs, tools);
    if (!toolResult) {
      console.error('Error: No tool specified or tool not found');
      console.error(
        'Available tools:',
        tools.map((t: Tool) => t.name.replace(/_/g, '-')).join(', '),
      );
      console.error('Use --help to see all available tools');
      await close();
      process.exit(1);
    }

    const { tool: selectedTool, toolName } = toolResult;

    // Check for tool-specific help
    const hasHelp = userArgs.some((arg: string) => arg === '--help' || arg === '-h');
    if (hasHelp) {
      printHelp(tools, selectedTool, { command: childCommand, args: childArgs, env: childEnv });
      await close();
      return;
    }

    if (globals.debug) {
      console.log('[DEBUG] Selected tool:', selectedTool.name);
      console.log('[DEBUG] Tool name used:', toolName);
    }

    // Parse parameters
    const params = parseParams(userArgs, selectedTool, toolName);

    // Validate required parameters
    if (selectedTool.inputSchema?.required) {
      const required = selectedTool.inputSchema.required as string[];
      const missing = required.filter((field) => !(field in params));
      if (missing.length > 0) {
        console.error(
          `Error: Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.map((p) => `--${p}`).join(', ')}`,
        );
        console.error(`\nUse --help for usage information:`);
        console.error(
          `  mcpli ${toolName} --help -- ${buildCommandString({ command: childCommand, args: childArgs, env: childEnv })}`,
        );
        process.exit(1);
      }
    }

    if (globals.debug) {
      console.log('[DEBUG] Parameters:', params);
      console.time('[DEBUG] Tool execution');
    }

    // Execute tool using daemon client
    let logFollower: { stop: () => void } | null = null;
    if (globals.verbose) {
      logFollower = spawnLiveLogFollower(process.cwd());
    }
    let executionResult: ToolCallResult;
    try {
      executionResult = await daemonClient.callTool({
        name: selectedTool.name,
        arguments: params,
      });
    } finally {
      if (logFollower) {
        logFollower.stop();
      }
    }

    if (globals.debug) {
      console.timeEnd('[DEBUG] Tool execution');
      console.time('[DEBUG] Cleanup');
    }

    await close();

    if (globals.debug) {
      console.timeEnd('[DEBUG] Cleanup');
    }

    // Output result
    if (globals.raw) {
      console.log(JSON.stringify(executionResult, null, 2));
    } else {
      const extracted = extractContent(executionResult);
      if (extracted !== null) {
        if (typeof extracted === 'string') {
          console.log(extracted);
        } else {
          console.log(JSON.stringify(extracted, null, 2));
        }
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
