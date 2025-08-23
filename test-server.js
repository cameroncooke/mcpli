#!/usr/bin/env node

/**
 * Simple test MCP server for testing MCPLI
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  {
    name: 'test-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Add some test tools
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the provided message',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The message to echo back'
          }
        },
        required: ['message']
      }
    },
    {
      name: 'get_weather',
      description: 'Get weather information for a location',
      inputSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The location to get weather for'
          },
          units: {
            type: 'string',
            description: 'Temperature units (celsius or fahrenheit)',
            default: 'fahrenheit'
          }
        },
        required: ['location']
      }
    },
    {
      name: 'list_items',
      description: 'List items with optional filtering',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Filter by category'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of items to return'
          },
          active_only: {
            type: 'boolean',
            description: 'Only return active items',
            default: false
          }
        }
      }
    }
  ]
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'echo':
      return {
        content: [
          {
            type: 'text',
            text: args?.message || 'No message provided'
          }
        ]
      };

    case 'get_weather':
      const location = args?.location || 'Unknown';
      const units = args?.units || 'fahrenheit';
      const temp = units === 'celsius' ? '22°C' : '72°F';
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              location,
              temperature: temp,
              condition: 'Sunny',
              humidity: '65%'
            })
          }
        ]
      };

    case 'list_items':
      const category = args?.category || 'all';
      const limit = args?.limit || 10;
      const activeOnly = args?.active_only || false;
      
      const items = [
        { id: 1, name: 'Item 1', category: 'electronics', active: true },
        { id: 2, name: 'Item 2', category: 'books', active: false },
        { id: 3, name: 'Item 3', category: 'electronics', active: true },
        { id: 4, name: 'Item 4', category: 'clothing', active: true },
        { id: 5, name: 'Item 5', category: 'books', active: true }
      ].filter(item => {
        if (category !== 'all' && item.category !== category) return false;
        if (activeOnly && !item.active) return false;
        return true;
      }).slice(0, limit);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(items)
          }
        ]
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});