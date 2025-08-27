#!/usr/bin/env node

/**
 * Test script for daemon restart after timeout
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log('=== Testing Daemon Restart After Timeout ===');

const testEnv = {
  ...process.env,
  MCPLI_DEFAULT_TIMEOUT: '3', // 3 seconds timeout
};

console.log('\n1. Starting daemon with 3 second timeout...');
const proc1 = spawn('./dist/mcpli.js', [
  'echo', '--message', 'first request', '--debug',
  '--', 'node', 'test-server.js'
], {
  stdio: 'inherit',
  env: testEnv
});

await new Promise(resolve => proc1.on('close', resolve));

// Get daemon PID
const getDaemonPid = async () => {
  const listProc = spawn('launchctl', ['list'], { stdio: 'pipe' });
  let output = '';
  listProc.stdout.on('data', data => output += data.toString());
  await new Promise(resolve => listProc.on('close', resolve));
  
  const mcpliJobs = output.split('\n').filter(line => line.includes('mcpli'));
  if (mcpliJobs.length > 0) {
    const pidMatch = mcpliJobs[0].match(/^(\d+)/);
    return pidMatch ? pidMatch[1] : null;
  }
  return null;
};

const pid1 = await getDaemonPid();
console.log(`\n2. First daemon PID: ${pid1}`);

console.log('3. Waiting 5 seconds for timeout (daemon should shut down)...');
await setTimeout(5000);

try {
  if (pid1) process.kill(pid1, 0);
  console.log('   ⚠️  Daemon still alive - extending wait time...');
  await setTimeout(2000);
} catch (err) {
  if (err.code === 'ESRCH') {
    console.log('   ✅ Daemon shut down due to inactivity timeout');
  }
}

console.log('\n4. Making new request after timeout (should restart daemon)...');
const proc2 = spawn('./dist/mcpli.js', [
  'echo', '--message', 'second request after timeout', '--debug',
  '--', 'node', 'test-server.js'
], {
  stdio: 'inherit',
  env: testEnv
});

await new Promise(resolve => proc2.on('close', resolve));

const pid2 = await getDaemonPid();
console.log(`\n5. Second daemon PID: ${pid2}`);

if (pid1 && pid2) {
  if (pid1 !== pid2) {
    console.log('   ✅ SUCCESS: New daemon started with different PID');
    console.log(`   Old PID: ${pid1}, New PID: ${pid2}`);
  } else {
    console.log('   ⚠️  Same PID - daemon might not have restarted');
  }
} else {
  console.log('   ℹ️  Could not compare PIDs');
}

console.log('\n6. Testing rapid requests to new daemon (should be fast)...');
const start = Date.now();

const proc3 = spawn('./dist/mcpli.js', [
  'echo', '--message', 'warm request test',
  '--', 'node', 'test-server.js'
], {
  stdio: 'pipe',
  env: testEnv
});

await new Promise(resolve => proc3.on('close', resolve));
const elapsed = Date.now() - start;

console.log(`   Warm request completed in ${elapsed}ms`);
if (elapsed < 200) {
  console.log('   ✅ SUCCESS: Warm request is fast (<200ms)');
} else {
  console.log('   ⚠️  Slower than expected (>200ms)');
}

console.log('\n=== Restart Test Complete ===');