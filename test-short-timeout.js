#!/usr/bin/env node

/**
 * Test script for daemon timeout using explicit environment variables
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log('=== Testing Daemon Timeout with Environment Variables ===');

// Set environment for 5 second timeout
const testEnv = {
  ...process.env,
  MCPLI_DEFAULT_TIMEOUT: '5', // 5 seconds default
};

console.log('\n1. Starting daemon with 5 second timeout via environment...');
const proc = spawn('./dist/mcpli.js', [
  'echo', '--message', 'environment timeout test', '--debug',
  '--', 'node', 'test-server.js'
], {
  stdio: 'inherit',
  env: testEnv
});

const result = await new Promise(resolve => {
  proc.on('close', resolve);
});

console.log(`\nRequest completed with code: ${result}`);

// Get the daemon PID for monitoring
const listProc = spawn('launchctl', ['list'], { stdio: 'pipe' });
let output = '';
listProc.stdout.on('data', data => output += data.toString());
await new Promise(resolve => listProc.on('close', resolve));

const mcpliJobs = output.split('\n').filter(line => line.includes('mcpli'));
console.log('Current MCPLI jobs:', mcpliJobs);

if (mcpliJobs.length > 0) {
  const pidMatch = mcpliJobs[0].match(/^(\d+)/);
  const pid = pidMatch ? pidMatch[1] : null;
  
  if (pid) {
    console.log(`\n2. Daemon running with PID: ${pid}`);
    console.log('3. Waiting 7 seconds for inactivity timeout...');
    
    // Monitor the process
    let processExists = true;
    const monitorInterval = setInterval(() => {
      try {
        process.kill(pid, 0); // Check if process exists (doesn't actually kill)
      } catch (err) {
        if (err.code === 'ESRCH') {
          console.log(`   Process ${pid} has terminated!`);
          processExists = false;
          clearInterval(monitorInterval);
        }
      }
    }, 1000);
    
    await setTimeout(8000);
    clearInterval(monitorInterval);
    
    if (!processExists) {
      console.log('\n✅ SUCCESS: Daemon timed out as expected!');
    } else {
      console.log('\n❌ Daemon still running after timeout period');
      try {
        process.kill(pid, 0);
        console.log('   Process is still alive');
      } catch (err) {
        console.log('   Process check failed:', err.message);
      }
    }
  }
}

console.log('\n=== Test Complete ===');