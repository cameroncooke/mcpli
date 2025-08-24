# MCPLI

**Transform any MCP server into a first-class CLI tool with an ergonomic CLI.**

MCPLI (Model Context Protocol CLI) dynamically discovers tools from MCP servers and generates first-class command-line interfaces automatically. No configuration needed - just point it at any MCP server and get instant CLI access to all its tools.

## Quick Start

```bash
# Install globally via npm
npm install -g mcpli

# Or run directly with npx
npx mcpli --help -- node your-mcp-server.js
```

## Features

- 🚀 **Zero Configuration** - Point at any MCP server, get instant CLI
- 🧠 **Dynamic Discovery** - Automatically finds all available tools
- 🎯 **Perfect Ergonomics** - Natural CLI syntax that feels familiar
- 📖 **Auto-Generated Help** - Detailed help for every tool and parameter
- ⚡ **High Performance** - Optional daemon mode for 100-1000x speedup
- 🔧 **Composable Output** - Clean JSON output perfect for piping
- 🛠️ **Type-Aware** - Automatic parameter type inference and validation

## Installation

### Global Installation
```bash
npm install -g mcpli
```

### Direct Usage (No Installation)
```bash
npx mcpli <command>
```

## Usage

### Basic Syntax
```bash
mcpli <tool> [tool-options...] -- <mcp-server> [args...]
```

### Discover Available Tools
```bash
# Show all tools available from a server
mcpli --help -- node weather-server.js
mcpli --help -- npx @your-org/mcp-server@latest
```

### Get Tool-Specific Help
```bash
# Show parameters for a specific tool
mcpli get-weather --help -- node weather-server.js
mcpli build-project --help -- npx xcode-mcp@latest
```

### Execute Tools
```bash
# Execute tools with natural CLI syntax
mcpli get-weather --location "San Francisco" --units "celsius" -- node weather-server.js
mcpli list-files --path "/home" --recursive -- node filesystem-mcp.js
mcpli build-project --scheme "MyApp" --destination "iPhone 15" -- npx xcode-mcp@latest
```

## Examples

### Weather Server
```bash
# Get current weather
mcpli get-weather --location "London" -- node weather-server.js

# Get forecast with specific units
mcpli forecast --location "Tokyo" --days 5 --units "metric" -- node weather-server.js
```

### File System Operations
```bash
# List directory contents
mcpli list-files --path "/etc" --show-hidden -- node fs-mcp-server.js

# Read file contents
mcpli read-file --path "/etc/hosts" -- node fs-mcp-server.js

# Search for files
mcpli find-files --pattern "*.json" --directory "/project" -- node fs-mcp-server.js
```

### Development Tools
```bash
# Run tests
mcpli run-tests --suite "integration" --coverage -- npx test-runner-mcp@latest

# Deploy application
mcpli deploy --environment "staging" --branch "main" -- npx deploy-mcp@latest

# Build iOS app
mcpli build-sim --project "./MyApp.xcodeproj" --scheme "MyApp" --simulator "iPhone 15" -- npx xcode-mcp@latest
```

## Advanced Features

### High-Performance Daemon Mode

MCPLI can run MCP servers as long-lived background processes for dramatically improved performance:

```bash
# Start a daemon (optional - auto-starts by default)
mcpli daemon start -- node your-server.js

# All subsequent commands use the fast daemon automatically
mcpli get-data --query "example"  # ~1000x faster

# Manage daemons
mcpli daemon status              # Show daemon info
mcpli daemon stop               # Stop daemon
mcpli daemon restart -- node your-server.js  # Restart with new config
```

### Composable Output

MCPLI produces clean, structured output perfect for shell pipelines:

```bash
# Pipe to jq for JSON processing
mcpli list-items -- node server.js | jq '.[].name'

# Filter and format results
mcpli get-weather --location "NYC" -- node weather.js | jq -r '.temperature'

# Chain with other CLI tools
mcpli search-files --pattern "*.log" -- node fs.js | xargs grep "ERROR"
```

### Parameter Types

MCPLI automatically handles all parameter types:

```bash
# Strings (default)
mcpli send-message --text "Hello world"

# Numbers
mcpli get-items --limit 10 --offset 50

# Booleans
mcpli list-files --recursive --show-hidden

# JSON objects and arrays
mcpli create-config --options '{"timeout": 30, "retries": 3}'
mcpli batch-process --items '["file1.txt", "file2.txt"]'
```

### Debug and Development

```bash
# Show raw MCP responses
mcpli get-data --debug --raw -- node server.js

# Enable verbose logging
mcpli process-file --logs --debug -- node server.js

# Show daemon usage
mcpli get-info --debug -- node server.js  # Shows "Using daemon: true"
```

## Real-World Examples

### iOS Development with Xcode MCP
```bash
# Discover available Xcode operations
mcpli --help -- npx xcode-buildmcp@latest

# Get help for specific build tool
mcpli build-sim --help -- npx xcode-buildmcp@latest

# Build and run on simulator
mcpli build-sim \
  --projectPath "/path/to/MyApp.xcodeproj" \
  --scheme "MyApp" \
  --simulatorName "iPhone 15 Pro" \
  -- npx xcode-buildmcp@latest
```

### Database Operations
```bash
# Connect and query
mcpli query --sql "SELECT * FROM users LIMIT 10" -- node postgres-mcp.js

# Run migrations
mcpli migrate --direction "up" --steps 1 -- node db-mcp-server.js

# Backup database
mcpli backup --format "sql" --compress -- node postgres-mcp.js > backup.sql.gz
```

### API Testing
```bash
# Make HTTP requests
mcpli http-get --url "https://api.example.com/users" -- node http-mcp.js

# Test endpoints
mcpli api-test --endpoint "/health" --expected-status 200 -- node api-test-mcp.js
```

## How It Works

1. **Dynamic Discovery**: MCPLI connects to your MCP server and calls `listTools()` to discover all available tools
2. **CLI Generation**: Each tool becomes a CLI command with auto-generated help and parameter parsing
3. **Type Inference**: Parameters are automatically typed based on JSON Schema from the MCP server
4. **Smart Execution**: Tools are executed via `callTool()` with proper parameter marshaling
5. **Output Processing**: Results are extracted and formatted for optimal CLI experience

## FAQ

**Q: Do I need to configure anything?**
A: No! Point MCPLI at any MCP server and it automatically discovers and exposes all tools.

**Q: What MCP servers work with MCPLI?**
A: Any compliant MCP server. Popular examples include filesystem, database, API, build tools, and custom business logic servers.

**Q: How is this different from calling MCP servers directly?**
A: MCPLI provides ergonomic CLI syntax, auto-generated help, type-safe parameters, composable output, and optional high-performance daemon mode.

**Q: Can I use this in shell scripts?**
A: Absolutely! MCPLI produces clean, structured output perfect for scripting and automation.

**Q: How fast is daemon mode?**
A: ~100-1000x faster than spawning processes. First call starts the daemon automatically, subsequent calls are nearly instantaneous.

## Requirements

- Node.js 18+
- Any MCP-compliant server

## Contributing

MCPLI is built to work with the entire MCP ecosystem. Found a compatibility issue? Please open an issue or PR.

## License

MIT

---

**Turn any MCP server into a beautiful CLI tool. Zero configuration. Maximum ergonomics.**