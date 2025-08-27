#!/usr/bin/env node

/**
 * Test script to verify daemon timeout behavior
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log('=== Testing Daemon Timeout Behavior ===');

// Test with 5 second timeout
console.log('\n1. Starting daemon with 5 second timeout...');
const result1 = await new Promise((resolve, reject) => {
  const proc = spawn('./dist/mcpli.js', [
    'echo', '--message', 'timeout test', '--timeout', '5', '--debug', 
    '--', 'node', 'test-server.js'
  ], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  
  proc.on('close', (code) => {
    resolve({ code });
  });
  
  proc.on('error', reject);
});

console.log(`\nFirst request completed with code: ${result1.code}`);

// Check daemon status
console.log('\n2. Checking daemon status immediately after request...');
const checkDaemon = spawn('launchctl', ['list'], { stdio: 'pipe' });
let output = '';
checkDaemon.stdout.on('data', (data) => output += data.toString());
await new Promise(resolve => checkDaemon.on('close', resolve));

const mcpliJobs = output.split('\n').filter(line => line.includes('mcpli'));
console.log('Active MCPLI daemons:', mcpliJobs);

// Wait 7 seconds (longer than 5 second timeout)
console.log('\n3. Waiting 7 seconds for timeout...');
await setTimeout(7000);

// Check daemon status again
console.log('\n4. Checking daemon status after timeout...');
const checkDaemon2 = spawn('launchctl', ['list'], { stdio: 'pipe' });
let output2 = '';
checkDaemon2.stdout.on('data', (data) => output2 += data.toString());
await new Promise(resolve => checkDaemon2.on('close', resolve));

const mcpliJobs2 = output2.split('\n').filter(line => line.includes('mcpli'));
console.log('Active MCPLI daemons after timeout:', mcpliJobs2);

if (mcpliJobs2.length < mcpliJobs.length) {
  console.log('\n✅ SUCCESS: Daemon timed out and shut down as expected');
} else {
  console.log('\n❌ ISSUE: Daemon did not time out');
}

console.log('\n=== Timeout Test Complete ===');