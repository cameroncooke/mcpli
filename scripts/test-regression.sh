#!/bin/bash
set -euo pipefail

# MCPLI Regression Test Script
# Tests core functionality to catch regressions after each commit

MCPLI="node dist/mcpli.js"
TEST_SERVER="node test-server.js"
WEATHER_SERVER="OPENAI_API_KEY=test node weather-server.js"

echo "🧪 MCPLI Regression Test Suite"
echo "=============================="

# Function to run test and capture result
run_test() {
  local test_name="$1"
  local command="$2"
  local expected_pattern="$3"
  
  echo -n "Testing $test_name... "
  
  # Run command and capture output
  if output=$(eval "$command" 2>&1); then
    # Check if output matches expected pattern
    if echo "$output" | grep -q "$expected_pattern"; then
      echo "✅ PASS"
      return 0
    else
      echo "❌ FAIL - Output didn't match expected pattern"
      echo "Expected pattern: $expected_pattern"
      echo "Actual output: $output"
      return 1
    fi
  else
    echo "❌ FAIL - Command failed"
    echo "Output: $output"
    return 1
  fi
}

# Function to test daemon operations
test_daemon_ops() {
  echo ""
  echo "🔧 Testing Daemon Operations"
  echo "----------------------------"
  
  # Clean up any existing state
  echo -n "Cleaning daemon state... "
  if $MCPLI daemon clean >/dev/null 2>&1; then
    echo "✅ PASS"
  else
    echo "❌ FAIL"
    return 1
  fi
  
  # Test daemon status (should show no daemons)
  echo -n "Checking clean state... "
  if output=$($MCPLI daemon status 2>&1); then
    if echo "$output" | grep -qE "(No running daemons found|No daemons found)"; then
      echo "✅ PASS"
    else
      echo "❌ FAIL - Expected no daemons, got: $output"
      return 1
    fi
  else
    echo "❌ FAIL - daemon status command failed"
    return 1
  fi
}

# Function to test basic tool calls
test_tool_calls() {
  echo ""
  echo "🛠️  Testing Tool Calls"
  echo "---------------------"
  
  # Test echo tool
  run_test "echo tool" \
    "$MCPLI echo --message \"test message\" -- $TEST_SERVER" \
    "test message"
  
  # Test delay tool with new validation
  run_test "delay tool" \
    "$MCPLI delay --duration_ms 100 -- $TEST_SERVER" \
    "Delayed for 100ms"
  
  # Test weather tool (basic functionality, not API call)
  run_test "weather server startup" \
    "$MCPLI get-weather --location \"Berlin\" -- $WEATHER_SERVER" \
    "Berlin"
}

# Function to test daemon persistence
test_daemon_persistence() {
  echo ""
  echo "🔄 Testing Daemon Persistence"
  echo "-----------------------------"
  
  # Make a call to create daemon
  echo -n "Creating daemon... "
  if $MCPLI echo --message "create daemon" -- $TEST_SERVER >/dev/null 2>&1; then
    echo "✅ PASS"
  else
    echo "❌ FAIL"
    return 1
  fi
  
  # Check daemon is running
  echo -n "Verifying daemon running... "
  if output=$($MCPLI daemon status 2>&1); then
    if echo "$output" | grep -q "Running: yes"; then
      echo "✅ PASS"
    else
      echo "❌ FAIL - Expected running daemon, got: $output"
      return 1
    fi
  else
    echo "❌ FAIL - daemon status failed"
    return 1
  fi
  
  # Make another call to same daemon (should reuse)
  run_test "daemon reuse" \
    "$MCPLI echo --message \"reuse daemon\" -- $TEST_SERVER" \
    "reuse daemon"
}

# Function to test error handling
test_error_handling() {
  echo ""
  echo "⚠️  Testing Error Handling"
  echo "-------------------------"
  
  # Test invalid tool
  echo -n "Testing invalid tool... "
  if output=$($MCPLI nonexistent-tool -- $TEST_SERVER 2>&1); then
    echo "❌ FAIL - Should have failed"
    return 1
  else
    if echo "$output" | grep -qE "(Unknown tool|tool not found)"; then
      echo "✅ PASS"
    else
      echo "❌ FAIL - Wrong error message: $output"
      return 1
    fi
  fi
  
  # Test delay tool validation (should reject >60000ms)
  echo -n "Testing delay validation... "
  if output=$($MCPLI delay --duration_ms 70000 -- $TEST_SERVER 2>&1); then
    echo "❌ FAIL - Should have rejected long delay"
    return 1
  else
    if echo "$output" | grep -q "between 0 and 60000"; then
      echo "✅ PASS"
    else
      echo "❌ FAIL - Wrong validation message: $output"
      return 1
    fi
  fi
}

# Function to test build artifacts
test_build_artifacts() {
  echo ""
  echo "📦 Testing Build Artifacts"
  echo "--------------------------"
  
  # Check main binary exists and is executable
  echo -n "Checking mcpli.js executable... "
  if [[ -f "dist/mcpli.js" && -x "dist/mcpli.js" ]]; then
    echo "✅ PASS"
  else
    echo "❌ FAIL - dist/mcpli.js missing or not executable"
    return 1
  fi
  
  # Check daemon wrapper exists and is executable
  echo -n "Checking wrapper.js executable... "
  if [[ -f "dist/daemon/wrapper.js" && -x "dist/daemon/wrapper.js" ]]; then
    echo "✅ PASS"
  else
    echo "❌ FAIL - dist/daemon/wrapper.js missing or not executable"
    return 1
  fi
}

# Main test execution
main() {
  local failed=0
  
  # Ensure we're in the right directory
  if [[ ! -f "package.json" || ! -f "dist/mcpli.js" ]]; then
    echo "❌ Error: Must run from project root with built artifacts"
    echo "   Run 'npm run build' first"
    exit 1
  fi
  
  # Run all test suites
  test_build_artifacts || failed=1
  test_daemon_ops || failed=1
  test_tool_calls || failed=1
  test_daemon_persistence || failed=1
  test_error_handling || failed=1
  
  # Cleanup
  echo ""
  echo "🧹 Cleanup"
  echo "----------"
  echo -n "Final cleanup... "
  if $MCPLI daemon clean >/dev/null 2>&1; then
    echo "✅ PASS"
  else
    echo "⚠️  Cleanup had issues"
  fi
  
  # Summary
  echo ""
  echo "📊 Test Results"
  echo "==============="
  if [[ $failed -eq 0 ]]; then
    echo "🎉 ALL TESTS PASSED - No regressions detected!"
    exit 0
  else
    echo "💥 TESTS FAILED - Regressions detected!"
    exit 1
  fi
}

# Handle script interruption
trap 'echo ""; echo "⏹️  Test interrupted - cleaning up..."; $MCPLI daemon clean >/dev/null 2>&1 || true; exit 1' INT TERM

# Run main function
main "$@"