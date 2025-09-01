#!/usr/bin/env node

/**
 * Simple Test MCP Server
 * 
 * A minimal MCP server with no external dependencies for testing
 * daemon lifecycle and IPC communication.
 * 
 * Tools:
 * - echo: Returns the input message
 * - fail: Intentionally throws an error
 * - delay: Waits for specified duration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'simple-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echoes back the input message',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        }
      },
      {
        name: 'fail',
        description: 'Intentionally throws an error',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
        }
      },
      {
        name: 'delay',
        description: 'Waits for a specified duration',
        inputSchema: {
          type: 'object',
          properties: {
            duration_ms: { type: 'number' }
          },
          required: ['duration_ms']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: argsRaw } = request.params ?? {};
  const args = argsRaw ?? {};

  switch (name) {
    case 'echo':
      if (typeof args.message !== 'string') {
        throw new Error('echo.message must be a string');
      }
      console.error(`[TOOL] echo called with message: ${args.message}`);
      return {
        content: [{ type: 'text', text: args.message }]
      };
    case 'fail':
      console.error(`[TOOL] fail called with message: ${args.message ?? 'no message'}`);
      throw new Error(typeof args.message === 'string'
        ? args.message
        : 'This is an intentional failure.');
    case 'delay':
      const ms = Number(args.duration_ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
        throw new Error('delay.duration_ms must be a number between 0 and 60000');
      }
      console.error(`[TOOL] delay called with duration: ${ms}ms`);
      await new Promise(resolve => setTimeout(resolve, ms));
      console.error(`[TOOL] delay completed after ${ms}ms`);
      return {
        content: [{ type: 'text', text: `Delayed for ${ms}ms` }]
      };
    default:
      console.error(`[TOOL] unknown tool called: ${name}`);
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Simple Test MCP Server running...');
}

main().catch(console.error);