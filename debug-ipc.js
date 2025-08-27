#!/usr/bin/env node

import net from 'net';

const socketPath = '/var/folders/_t/2njffz894t57qpp76v1sw__h0000gn/T/mcpli/13175e13/b3716a57.sock';

console.time('IPC Request');

const client = net.connect(socketPath);
let response = '';

client.on('connect', () => {
  console.timeLog('IPC Request', 'Connected');
  const request = {
    id: 'test-' + Date.now(),
    method: 'callTool',
    params: {
      name: 'echo',
      arguments: { message: 'timing test' }
    }
  };
  client.write(JSON.stringify(request) + '\n');
});

client.on('data', (data) => {
  response += data.toString();
  if (response.includes('\n')) {
    console.timeLog('IPC Request', 'Response received');
    console.log('Response:', response.trim());
    console.timeEnd('IPC Request');
    client.end();
  }
});

client.on('error', (err) => {
  console.error('Error:', err);
  console.timeEnd('IPC Request');
});