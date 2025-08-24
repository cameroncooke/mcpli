#!/usr/bin/env node

/**
 * MCPLI - Turn any MCP server into a first-class CLI tool
 * 
 * This version supports both stateless mode and long-lived daemon processes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DaemonClient } from './daemon/index.js';
import { 
  handleDaemonStart, 
  handleDaemonStop, 
  handleDaemonStatus, 
  handleDaemonRestart,
  handleDaemonLogs,
  handleDaemonClean,
  printDaemonHelp
} from './daemon/index.js';

interface GlobalOptions {
  help?: boolean;
  quiet?: boolean;
  raw?: boolean;
  debug?: boolean;
  logs?: boolean;
  timeout?: number;
  daemon?: boolean;
  force?: boolean;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2); // Remove node and script name
  const globals: GlobalOptions = { timeout: 30000 };
  
  // Check for daemon subcommand
  if (args[0] === 'daemon') {
    globals.daemon = true;
    
    // Check if help is requested for daemon
    if (args[1] === '--help' || args[1] === '-h') {
      globals.help = true;
      return { 
        globals, 
        daemonCommand: '',
        daemonArgs: [],
        childCommand: '',
        childArgs: [],
        userArgs: []
      };
    }
    
    const daemonCommand = args[1];
    const daemonArgs = args.slice(2);
    
    // Parse daemon-specific options
    for (const arg of daemonArgs) {
      if (arg === '--help' || arg === '-h') globals.help = true;
      else if (arg === '--debug') globals.debug = true;
      else if (arg === '--logs') globals.logs = true;
      else if (arg === '--force') globals.force = true;
      else if (arg.startsWith('--timeout=')) {
        globals.timeout = parseInt(arg.split('=')[1], 10);
      }
    }
    
    return { 
      globals, 
      daemonCommand, 
      daemonArgs,
      childCommand: '',
      childArgs: [],
      userArgs: []
    };
  }
  
  // Regular tool execution mode - find the -- separator
  const dashIndex = args.indexOf('--');
  if (dashIndex === -1) {
    // For help or when no command specified, allow missing --
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
      return {
        globals: { ...globals, help: true },
        childCommand: '',
        childArgs: [],
        userArgs: args
      };
    }
    
    console.error('Error: Child command required after --');
    console.error('Usage: mcpli [options] [tool] [params...] -- <command> [args...]');
    console.error('       mcpli daemon <subcommand> [options]');
    process.exit(1);
  }
  
  const childCommand = args[dashIndex + 1];
  const childArgs = args.slice(dashIndex + 2);
  const userArgs = args.slice(0, dashIndex);
  
  if (!childCommand) {
    console.error('Error: Child command required after --');
    process.exit(1);
  }
  
  // Parse global options - but don't set help=true if there's a tool name before --help
  let foundToolName = false;
  for (const arg of userArgs) {
    if (!arg.startsWith('--') && !arg.startsWith('-') && !foundToolName) {
      foundToolName = true; // This might be a tool name
      continue;
    }
    
    if (arg === '--help' || arg === '-h') {
      // Only set global help if no tool name was found
      if (!foundToolName) {
        globals.help = true;
      }
    }
    else if (arg === '--quiet' || arg === '-q') globals.quiet = true;
    else if (arg === '--raw') globals.raw = true;
    else if (arg === '--debug') globals.debug = true;
    else if (arg === '--logs') globals.logs = true;
    else if (arg.startsWith('--timeout=')) {
      globals.timeout = parseInt(arg.split('=')[1], 10);
    }
  }
  
  return { globals, childCommand, childArgs, userArgs };
}

async function discoverTools(command: string, args: string[], options: GlobalOptions) {
  // Try daemon client first, with fallback to direct connection
  const daemonClient = new DaemonClient(command, args, {
    logs: options.logs,
    debug: options.debug,
    timeout: options.timeout,
    autoStart: true,
    fallbackToStateless: true
  });
  
  try {
    const result = await daemonClient.listTools();
    return { 
      tools: result.tools || [], 
      daemonClient,
      isDaemon: true,
      close: () => Promise.resolve()
    };
  } catch (error) {
    // Fallback to direct connection
    if (options.debug) {
      console.error('[DEBUG] Daemon failed, using direct connection:', error);
    }
    
    const transport = new StdioClientTransport({
      command,
      args,
      stderr: options.logs ? 'inherit' : 'ignore'
    });
    
    const client = new Client({
      name: 'mcpli',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
    
    try {
      await client.connect(transport);
      const result = await client.listTools();
      return { 
        tools: result.tools || [], 
        client, 
        isDaemon: false,
        close: () => client.close() 
      };
    } catch (error) {
      throw new Error(`Failed to connect to MCP server: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(userArgs: string[], tools: any[]) {
  const toolMap = new Map();
  
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
      if (toolMap.has(arg)) {
        return { tool: toolMap.get(arg), toolName: arg };
      }
    }
  }
  
  return null;
}

function parseParams(userArgs: string[], selectedTool: any, toolName: string) {
  const params: Record<string, any> = {};
  let foundTool = false;
  
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i];
    
    // Skip until we find the tool name
    if (arg === toolName) {
      foundTool = true;
      continue;
    }
    
    // Only process arguments after the tool name
    if (!foundTool) continue;
    
    // Handle --flag value pairs
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = userArgs[i + 1];
      
      // If next argument exists and doesn't start with --, it's the value
      if (nextArg && !nextArg.startsWith('-')) {
        // Try to parse as JSON, fall back to string
        try {
          if (nextArg.startsWith('[') || nextArg.startsWith('{') || 
              nextArg === 'true' || nextArg === 'false' || 
              !isNaN(Number(nextArg))) {
            params[key] = JSON.parse(nextArg);
          } else {
            params[key] = nextArg;
          }
        } catch {
          params[key] = nextArg;
        }
        i++; // Skip the value argument
      } else {
        // Boolean flag
        params[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Handle single letter flags like -f
      const key = arg.slice(1);
      const nextArg = userArgs[i + 1];
      
      if (nextArg && !nextArg.startsWith('-')) {
        try {
          if (nextArg.startsWith('[') || nextArg.startsWith('{') || 
              nextArg === 'true' || nextArg === 'false' || 
              !isNaN(Number(nextArg))) {
            params[key] = JSON.parse(nextArg);
          } else {
            params[key] = nextArg;
          }
        } catch {
          params[key] = nextArg;
        }
        i++; // Skip the value argument
      } else {
        params[key] = true;
      }
    }
  }
  
  return params;
}

function extractContent(result: any): any {
  if (!result.content || result.content.length === 0) {
    return null;
  }
  
  if (result.content.length === 1) {
    const item = result.content[0];
    if (item.type === 'text') {
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
    return item;
  }
  
  return result.content.map((item: any) => {
    if (item.type === 'text') {
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
    return item;
  });
}

function printHelp(tools: any[], specificTool?: any) {
  if (specificTool) {
    printToolHelp(specificTool);
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
  console.log('  --logs         Enable server log output (disabled by default)');
  console.log('  --raw          Print raw MCP response');
  console.log('  --debug        Enable debug output');
  console.log('  --timeout=<ms> Set daemon timeout (default: 30000)');
  console.log('');
  console.log('Daemon Commands:');
  console.log('  daemon start   Start long-lived daemon process');
  console.log('  daemon stop    Stop daemon process');
  console.log('  daemon status  Show daemon status');
  console.log('  daemon restart Restart daemon process');
  console.log('  daemon logs    Show daemon logs');
  console.log('  daemon clean   Clean up daemon files');
  console.log('');
  
  if (tools.length > 0) {
    console.log('Available Tools:');
    for (const tool of tools) {
      const name = tool.name.replace(/_/g, '-');
      const desc = tool.description || 'No description';
      console.log(`  ${name.padEnd(20)} ${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}`);
    }
    console.log('');
    console.log('Tool Help:');
    console.log(`  mcpli <tool> --help -- <mcp-server-command>    Show detailed help for specific tool`);
    console.log('');
    console.log('Examples:');
    console.log(`  mcpli ${tools[0].name.replace(/_/g, '-')} --help -- node server.js`);
    console.log(`  mcpli ${tools[0].name.replace(/_/g, '-')} --option value -- node server.js`);
    console.log('');
    console.log('Fast Execution (via auto-daemon):');
    console.log(`  mcpli ${tools[0].name.replace(/_/g, '-')} --option value  # No MCP server command needed after first use`);
  } else {
    console.log('No tools found. The MCP server may not be responding correctly.');
    console.log('');
    console.log('Examples:');
    console.log('  mcpli --help -- node server.js       # Show tools from server.js');
    console.log('  mcpli daemon start -- node server.js # Start long-lived daemon');
  }
}

function printToolHelp(tool: any) {
  console.log(`MCPLI Tool: ${tool.name}`);
  console.log('');
  if (tool.description) {
    console.log(`Description: ${tool.description}`);
    console.log('');
  }
  
  console.log(`Usage: mcpli ${tool.name} [options] -- <mcp-server-command> [args...]`);
  console.log('');
  
  if (tool.inputSchema && tool.inputSchema.properties) {
    console.log('Options:');
    const properties = tool.inputSchema.properties;
    const required = tool.inputSchema.required || [];
    
    for (const [propName, propSchema] of Object.entries(properties)) {
      const schema = propSchema as any;
      const isRequired = required.includes(propName);
      const type = schema.type || 'string';
      const description = schema.description || '';
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
  console.log(`  mcpli ${exampleName} --help -- node server.js`);
  
  if (tool.inputSchema && tool.inputSchema.properties) {
    const properties = Object.keys(tool.inputSchema.properties);
    if (properties.length > 0) {
      const firstProp = properties[0];
      console.log(`  mcpli ${exampleName} --${firstProp} "example-value" -- node server.js`);
    }
  }
}

async function main() {
  try {
    const result = parseArgs(process.argv);
    const { globals } = result;
    
    if (globals.debug) {
      console.error('[DEBUG] Parsed args:', result);
    }
    
    // Handle daemon subcommands
    if (globals.daemon) {
      const { daemonCommand, daemonArgs } = result as any;
      
      if (globals.help || !daemonCommand) {
        printDaemonHelp();
        return;
      }
      
      const options = {
        debug: globals.debug,
        logs: globals.logs,
        force: globals.force,
        timeout: globals.timeout
      };
      
      switch (daemonCommand) {
        case 'start':
          const dashIndex = daemonArgs.indexOf('--');
          if (dashIndex === -1) {
            console.error('Error: Command required after -- for daemon start');
            console.error('Usage: mcpli daemon start -- <command> [args...]');
            process.exit(1);
          }
          const command = daemonArgs[dashIndex + 1];
          const args = daemonArgs.slice(dashIndex + 2);
          if (!command) {
            console.error('Error: Command required after --');
            process.exit(1);
          }
          await handleDaemonStart(command, args, options);
          break;
          
        case 'stop':
          await handleDaemonStop(options);
          break;
          
        case 'status':
          await handleDaemonStatus(options);
          break;
          
        case 'restart':
          const restartDashIndex = daemonArgs.indexOf('--');
          if (restartDashIndex === -1) {
            console.error('Error: Command required after -- for daemon restart');
            console.error('Usage: mcpli daemon restart -- <command> [args...]');
            process.exit(1);
          }
          const restartCommand = daemonArgs[restartDashIndex + 1];
          const restartArgs = daemonArgs.slice(restartDashIndex + 2);
          if (!restartCommand) {
            console.error('Error: Command required after --');
            process.exit(1);
          }
          await handleDaemonRestart(restartCommand, restartArgs, options);
          break;
          
        case 'logs':
          await handleDaemonLogs(options);
          break;
          
        case 'clean':
          await handleDaemonClean(options);
          break;
          
        default:
          console.error(`Error: Unknown daemon command: ${daemonCommand}`);
          console.error('Use "mcpli daemon --help" to see available commands');
          process.exit(1);
      }
      
      return;
    }
    
    // Regular tool execution mode
    const { childCommand, childArgs, userArgs } = result;
    
    if (!childCommand && !globals.help) {
      console.error('Error: Command required after --');
      console.error('Usage: mcpli [options] [tool] [params...] -- <command> [args...]');
      process.exit(1);
    }
    
    // Show help for regular mode
    if (globals.help) {
      if (childCommand) {
        // Get tools to show in help - always discover tools for root help
        try {
          const { tools, close } = await discoverTools(childCommand, childArgs, globals);
          printHelp(tools);
          await close();
        } catch (error) {
          console.error(`Error connecting to MCP server: ${error instanceof Error ? error.message : error}`);
          console.error('Cannot show available tools. Please check your MCP server command.');
          printHelp([]);
        }
      } else {
        console.error('Error: MCP server command required to show available tools');
        console.error('Usage: mcpli --help -- <mcp-server-command> [args...]');
        console.error('Example: mcpli --help -- node server.js');
        process.exit(1);
      }
      return;
    }
    
    if (globals.debug) {
      console.error('[DEBUG] Tool execution mode:', { childCommand, childArgs, userArgs });
    }
    
    // Discover tools
    const { tools, client, daemonClient, isDaemon, close } = await discoverTools(childCommand, childArgs, globals);
    
    if (globals.debug) {
      console.error('[DEBUG] Found tools:', tools.map((t: any) => t.name));
      console.error('[DEBUG] Using daemon:', isDaemon);
    }
    
    // Show help if no tool specified
    if (userArgs.length === 0) {
      printHelp(tools);
      await close();
      return;
    }
    
    // Find selected tool
    const toolResult = findTool(userArgs, tools);
    if (!toolResult) {
      console.error('Error: No tool specified or tool not found');
      console.error('Available tools:', tools.map((t: any) => t.name.replace(/_/g, '-')).join(', '));
      console.error('Use --help to see all available tools');
      await close();
      process.exit(1);
    }
    
    const { tool: selectedTool, toolName } = toolResult;
    
    // Check for tool-specific help
    const hasHelp = userArgs.some((arg: string) => arg === '--help' || arg === '-h');
    if (hasHelp) {
      printHelp(tools, selectedTool);
      await close();
      return;
    }
    
    if (globals.debug) {
      console.error('[DEBUG] Selected tool:', selectedTool.name);
      console.error('[DEBUG] Tool name used:', toolName);
    }
    
    // Parse parameters
    const params = parseParams(userArgs, selectedTool, toolName);
    
    if (globals.debug) {
      console.error('[DEBUG] Parameters:', params);
    }
    
    // Execute tool using appropriate client
    let executionResult;
    if (isDaemon && daemonClient) {
      executionResult = await daemonClient.callTool({
        name: selectedTool.name,
        arguments: params
      });
    } else if (client) {
      executionResult = await client.callTool({
        name: selectedTool.name,
        arguments: params
      });
    } else {
      throw new Error('No client available for tool execution');
    }
    
    await close();
    
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