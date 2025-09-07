#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'timeout-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'delay',
      description: 'Delays for the specified number of seconds',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: 'Number of seconds to delay',
          },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'quick',
      description: 'Returns immediately',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  console.error(`[${new Date().toISOString()}] Tool call started: ${request.params.name}`);
  
  try {
    switch (request.params.name) {
      case 'delay': {
        const seconds = request.params.arguments?.seconds || 30;
        console.error(`[${new Date().toISOString()}] Starting delay for ${seconds} seconds`);
        
        // Log progress every 10 seconds
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += 10;
          if (elapsed < seconds) {
            console.error(`[${new Date().toISOString()}] Still delaying... ${elapsed}/${seconds} seconds elapsed`);
          }
        }, 10000);
        
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        clearInterval(interval);
        
        const totalTime = (Date.now() - startTime) / 1000;
        console.error(`[${new Date().toISOString()}] Delay completed after ${totalTime.toFixed(1)} seconds`);
        
        return {
          content: [
            {
              type: 'text',
              text: `Successfully delayed for ${seconds} seconds (actual: ${totalTime.toFixed(1)}s)`,
            },
          ],
        };
      }
      
      case 'quick': {
        console.error(`[${new Date().toISOString()}] Quick tool returning immediately`);
        return {
          content: [
            {
              type: 'text',
              text: 'Quick response!',
            },
          ],
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Tool error:`, error);
    throw error;
  }
});

async function main() {
  console.error(`[${new Date().toISOString()}] Starting timeout-test-server...`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${new Date().toISOString()}] timeout-test-server running on stdio`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});