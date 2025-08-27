#!/usr/bin/env node

/**
 * Test script for daemon signal handling
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log('=== Testing Daemon Signal Handling ===');

// Start a daemon first
console.log('\n1. Starting daemon...');
const proc = spawn('./dist/mcpli.js', [
  'echo', '--message', 'signal test', '--debug',
  '--', 'node', 'test-server.js'
], {
  stdio: 'inherit'
});

await new Promise(resolve => proc.on('close', resolve));

// Get daemon PID
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
    console.log('3. Sending SIGTERM signal...');
    
    try {
      process.kill(pid, 'SIGTERM');
      console.log('   SIGTERM sent successfully');
      
      // Wait a bit and check if process terminated
      await setTimeout(2000);
      
      try {
        process.kill(pid, 0); // Check if still alive
        console.log('   ⚠️  Process still alive after SIGTERM');
        
        console.log('4. Sending SIGKILL as cleanup...');
        process.kill(pid, 'SIGKILL');
        await setTimeout(1000);
        
      } catch (err) {
        if (err.code === 'ESRCH') {
          console.log('   ✅ Process terminated gracefully after SIGTERM');
        }
      }
      
    } catch (err) {
      console.log('   Error sending signal:', err.message);
    }
  }
}

// Test SIGINT as well
console.log('\n5. Testing SIGINT handling...');
console.log('   Starting new daemon...');

const proc2 = spawn('./dist/mcpli.js', [
  'echo', '--message', 'sigint test', '--debug',
  '--', 'node', 'test-server.js'  
], {
  stdio: 'inherit'
});

await new Promise(resolve => proc2.on('close', resolve));

// Get new daemon PID
const listProc2 = spawn('launchctl', ['list'], { stdio: 'pipe' });
let output2 = '';
listProc2.stdout.on('data', data => output2 += data.toString());
await new Promise(resolve => listProc2.on('close', resolve));

const mcpliJobs2 = output2.split('\n').filter(line => line.includes('mcpli'));
console.log('   New daemon jobs:', mcpliJobs2);

if (mcpliJobs2.length > 0) {
  const pidMatch2 = mcpliJobs2[0].match(/^(\d+)/);
  const pid2 = pidMatch2 ? pidMatch2[1] : null;
  
  if (pid2) {
    console.log(`   New daemon PID: ${pid2}`);
    console.log('   Sending SIGINT signal...');
    
    try {
      process.kill(pid2, 'SIGINT');
      console.log('   SIGINT sent successfully');
      
      await setTimeout(2000);
      
      try {
        process.kill(pid2, 0);
        console.log('   ⚠️  Process still alive after SIGINT');
        process.kill(pid2, 'SIGKILL'); // cleanup
      } catch (err) {
        if (err.code === 'ESRCH') {
          console.log('   ✅ Process terminated gracefully after SIGINT');
        }
      }
      
    } catch (err) {
      console.log('   Error sending SIGINT:', err.message);
    }
  }
}

console.log('\n=== Signal Testing Complete ===');