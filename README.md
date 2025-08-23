# MCPLI - Working Demo

🎉 **Success!** MCPLI is working and demonstrates the core concept perfectly.

## What It Does

MCPLI transforms any MCP server into a first-class CLI tool by:

1. **Discovering tools dynamically** from the MCP server
2. **Generating CLI commands** based on discovered tools  
3. **Providing ergonomic interfaces** with multiple naming conventions
4. **Extracting clean data** from MCP responses
5. **Enabling composition** with other CLI tools

## Installation & Usage

```bash
# Build the project
npm install && npm run build

# Show help with discovered tools
./dist/mcpli.js --help -- node test-server-fixed.js

# Call tools with parameters
./dist/mcpli.js --echo message="Hello World!" -- node test-server-fixed.js
./dist/mcpli.js --get-weather location="NYC" units="celsius" -- node test-server-fixed.js  
./dist/mcpli.js --list-items category="electronics" active_only=true -- node test-server-fixed.js

# Alternative syntax (no dashes)
./dist/mcpli.js echo message="Hello!" -- node test-server-fixed.js
./dist/mcpli.js list_items category="books" limit=2 -- node test-server-fixed.js

# Compose with other tools
./dist/mcpli.js list_items category="electronics" -- node test-server-fixed.js | jq '.[].name'
```

## Key Features Demonstrated

### ✅ Dynamic CLI Generation
```bash
$ ./dist/mcpli.js --help -- node test-server-fixed.js
Available Tools:
  --echo                 Echo back the provided message
  --get-weather          Get weather information for a location
  --list-items           List items with optional filtering
```

### ✅ Tool Name Flexibility  
```bash
# These all work:
./dist/mcpli.js --list-items ...     # kebab-case
./dist/mcpli.js list_items ...       # snake_case  
./dist/mcpli.js listItems ...        # camelCase (would work)
```

### ✅ Enhanced Output
```bash
# Raw MCP response
$ ./dist/mcpli.js --raw --echo message="test" -- node test-server-fixed.js
{
  "content": [{"type": "text", "text": "test"}]
}

# Extracted clean data (default)
$ ./dist/mcpli.js --echo message="test" -- node test-server-fixed.js  
test
```

### ✅ Composability
```bash
# Perfect for piping to other tools
./dist/mcpli.js list_items -- node test-server-fixed.js | jq '.[].name'
./dist/mcpli.js get-weather location="NYC" -- node test-server-fixed.js | jq '.temperature'
```

### ✅ Parameter Types
```bash
# String parameters
message="Hello World"

# Boolean parameters  
active_only=true

# Number parameters
limit=5

# JSON parameters (arrays/objects)
config='{"key":"value"}'
items='["item1","item2"]'
```

## Test Results

All core functionality is working:

- ✅ Dynamic tool discovery from MCP server
- ✅ Multiple tool name formats (kebab-case, snake_case) 
- ✅ Parameter parsing with type inference
- ✅ Enhanced output extraction (JSON parsing from text content)
- ✅ Raw output mode for debugging
- ✅ Clean composable output for piping
- ✅ Help generation based on discovered tools
- ✅ Error handling for missing tools/parameters

## Architecture

The minimal implementation (500 lines) demonstrates all key concepts:

1. **parseArgs()** - Parses CLI arguments and separates global options from tool params
2. **discoverTools()** - Connects to MCP server and calls `listTools()`
3. **findTool()** - Matches user input to discovered tools with name normalization
4. **parseParams()** - Converts CLI arguments to tool parameters with type inference
5. **extractContent()** - Extracts useful data from MCP responses
6. **printHelp()** - Generates dynamic help based on discovered tools

## Next Steps

This working version proves the concept. Next:

1. **Enhance parameter validation** using JSON Schema from tool definitions
2. **Add more output formats** (text mode, structured formats)
3. **Improve error messages** and validation feedback  
4. **Add resource and prompt support** (beyond just tools)
5. **Create installable npm package** for global use
6. **Integrate with Reloaderoo** by extracting shared components

## Usage Examples

### Weather Server
```bash
./dist/mcpli.js get-weather location="London" -- node weather-server.js
./dist/mcpli.js get-forecast location="Paris" days=5 -- node weather-server.js | jq '.forecast[].temp'
```

### File System Server  
```bash
./dist/mcpli.js list-files path="/home" -- node fs-server.js
./dist/mcpli.js read-file path="/etc/hosts" -- node fs-server.js
```

### Development Server
```bash
./dist/mcpli.js run-tests suite="unit" -- node dev-server.js
./dist/mcpli.js deploy env="staging" -- node dev-server.js | jq '.status'
```

The core vision is achieved: **Any MCP server becomes a first-class CLI tool with ergonomic syntax and composable output!** 🎯