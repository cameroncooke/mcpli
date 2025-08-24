#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'complex-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Test tool with comprehensive JSON Schema data types
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'test_all_types',
        description: 'Test tool with all JSON Schema data types',
        inputSchema: {
          type: 'object',
          properties: {
            // Primitive types
            text: { type: 'string', description: 'A string value' },
            count: { type: 'integer', description: 'An integer value' },
            rating: { type: 'number', description: 'A decimal number' },
            enabled: { type: 'boolean', description: 'A boolean flag' },
            empty: { type: 'null', description: 'A null value' },

            // Array types
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of strings'
            },
            scores: {
              type: 'array',
              items: { type: 'number' },
              description: 'Array of numbers'
            },

            // Object types
            config: {
              type: 'object',
              properties: {
                timeout: { type: 'number' },
                retries: { type: 'integer' },
                debug: { type: 'boolean' }
              },
              description: 'Configuration object'
            },

            // Complex nested object
            metadata: {
              type: 'object',
              properties: {
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    preferences: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  }
                },
                timestamps: {
                  type: 'array',
                  items: { type: 'number' }
                }
              },
              description: 'Complex nested metadata'
            }
          },
          required: ['text', 'count']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'test_all_types') {
    return {
      content: [
        {
          type: 'text',
          text: `Received arguments: ${JSON.stringify(args, null, 2)}\n\nArgument types:\n${Object.entries(args).map(([key, value]) => `${key}: ${typeof value} (${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value})`).join('\n')}`
        }
      ]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);