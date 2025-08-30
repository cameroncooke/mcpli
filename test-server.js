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
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'echo':
      return {
        content: [{ type: 'text', text: args.message }]
      };
    case 'fail':
      throw new Error(args.message || 'This is an intentional failure.');
    case 'delay':
      await new Promise(resolve => setTimeout(resolve, args.duration_ms));
      return {
        content: [{ type: 'text', text: `Delayed for ${args.duration_ms}ms` }]
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Simple Test MCP Server running...');
}

main().catch(console.error);