#!/usr/bin/env node

/**
 * MCPLI - Turn any MCP server into a first-class CLI tool
 * 
 * This is a minimal working version to demonstrate the core concept.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface GlobalOptions {
  help?: boolean;
  quiet?: boolean;
  raw?: boolean;
  debug?: boolean;
  logs?: boolean;
  timeout?: number;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2); // Remove node and script name
  const globals: GlobalOptions = { timeout: 30000 };
  
  // Find the -- separator
  const dashIndex = args.indexOf('--');
  if (dashIndex === -1) {
    console.error('Error: Child command required after --');
    console.error('Usage: mcpli [options] [tool] [params...] -- <command> [args...]');
    process.exit(1);
  }
  
  const childCommand = args[dashIndex + 1];
  const childArgs = args.slice(dashIndex + 2);
  const userArgs = args.slice(0, dashIndex);
  
  if (!childCommand) {
    console.error('Error: Child command required after --');
    process.exit(1);
  }
  
  // Parse global options
  for (const arg of userArgs) {
    if (arg === '--help' || arg === '-h') globals.help = true;
    else if (arg === '--quiet' || arg === '-q') globals.quiet = true;
    else if (arg === '--raw') globals.raw = true;
    else if (arg === '--debug') globals.debug = true;
    else if (arg === '--logs') globals.logs = true;
  }
  
  return { globals, childCommand, childArgs, userArgs };
}

async function discoverTools(command: string, args: string[], options: GlobalOptions) {
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: options.logs ? 'inherit' : 'ignore'  // Suppress by default, enable with --logs
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
    return { tools: result.tools || [], client, close: () => client.close() };
  } catch (error) {
    throw new Error(`Failed to connect to MCP server: ${error instanceof Error ? error.message : error}`);
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
  
  // Look for tool selection
  for (const arg of userArgs) {
    if (arg.startsWith('--')) {
      const toolName = arg.slice(2);
      if (toolMap.has(toolName)) {
        return toolMap.get(toolName);
      }
    } else if (!arg.includes('=')) {
      if (toolMap.has(arg)) {
        return toolMap.get(arg);
      }
    }
  }
  
  return null;
}

function parseParams(userArgs: string[], selectedTool: any) {
  const params: Record<string, any> = {};
  const toolName = selectedTool?.name;
  
  for (const arg of userArgs) {
    // Skip tool selection
    if (arg === toolName || arg === `--${toolName}` || arg === `--${toolName.replace(/_/g, '-')}`) {
      continue;
    }
    
    if (arg.includes('=')) {
      const [key, value] = arg.split('=', 2);
      const cleanKey = key.replace(/^--/, '');
      
      // Try to parse as JSON, fall back to string
      try {
        if (value.startsWith('[') || value.startsWith('{') || value === 'true' || value === 'false' || !isNaN(Number(value))) {
          params[cleanKey] = JSON.parse(value);
        } else {
          params[cleanKey] = value;
        }
      } catch {
        params[cleanKey] = value;
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

function printHelp(tools: any[]) {
  console.log('MCPLI - Turn any MCP server into a first-class CLI tool');
  console.log('');
  console.log('Usage:');
  console.log('  mcpli [options] [--tool | tool] [params...] -- <command> [args...]');
  console.log('');
  console.log('Global Options:');
  console.log('  --help, -h     Show this help');
  console.log('  --logs         Enable server log output (disabled by default)');
  console.log('  --raw          Print raw MCP response');
  console.log('  --debug        Enable debug output');
  console.log('');
  
  if (tools.length > 0) {
    console.log('Available Tools:');
    for (const tool of tools) {
      const name = tool.name.replace(/_/g, '-');
      const desc = tool.description || 'No description';
      console.log(`  --${name.padEnd(20)} ${desc.slice(0, 50)}${desc.length > 50 ? '...' : ''}`);
    }
    console.log('');
    console.log('Examples:');
    console.log(`  mcpli --${tools[0].name.replace(/_/g, '-')} -- node server.js`);
    console.log(`  mcpli ${tools[0].name} param="value" -- node server.js`);
  } else {
    console.log('Examples:');
    console.log('  mcpli --help -- node server.js');
  }
}

async function main() {
  try {
    const { globals, childCommand, childArgs, userArgs } = parseArgs(process.argv);
    
    if (globals.debug) {
      console.error('[DEBUG] Args:', { childCommand, childArgs, userArgs });
    }
    
    // Discover tools
    const { tools, client, close } = await discoverTools(childCommand, childArgs, globals);
    
    if (globals.debug) {
      console.error('[DEBUG] Found tools:', tools.map((t: any) => t.name));
    }
    
    // Show help if requested or no tool specified
    if (globals.help || userArgs.length === 0) {
      printHelp(tools);
      await close();
      return;
    }
    
    // Find selected tool
    const selectedTool = findTool(userArgs, tools);
    if (!selectedTool) {
      console.error('Error: No tool specified or tool not found');
      console.error('Use --help to see available tools');
      await close();
      process.exit(1);
    }
    
    if (globals.debug) {
      console.error('[DEBUG] Selected tool:', selectedTool.name);
    }
    
    // Parse parameters
    const params = parseParams(userArgs, selectedTool);
    
    if (globals.debug) {
      console.error('[DEBUG] Parameters:', params);
    }
    
    // Execute tool
    const result = await client.callTool({
      name: selectedTool.name,
      arguments: params
    });
    
    await close();
    
    // Output result
    if (globals.raw) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const extracted = extractContent(result);
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