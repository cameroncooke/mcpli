# Contributing

Contributions are welcome! Here's how you can help improve MCPLI.

## Local development setup

### Prerequisites

- Node.js (v18 or later)
- npm
- Git

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/cameroncooke/mcpli.git
   cd mcpli
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Test the CLI:
   ```bash
   ./dist/mcpli.js --help -- node weather-server.js
   ```

### Development Workflow

#### Building
```bash
# Build once
npm run build

# Build and copy files
npm run dev
```

#### Testing with MCP Servers

The repository includes a sample weather server for testing:

```bash
# Test help output
./dist/mcpli.js --help -- node weather-server.js

# Test tool-specific help
./dist/mcpli.js get-weather --help -- node weather-server.js

# Test tool execution
./dist/mcpli.js get-weather --location "San Francisco" -- node weather-server.js

# Test with pipes
./dist/mcpli.js get-weather --location "NYC" -- node weather-server.js | jq -r '.temperature'
```

#### Daemon Development

Test the daemon functionality:

```bash
# Start daemon explicitly
./dist/mcpli.js daemon start -- node weather-server.js

# Check daemon status
./dist/mcpli.js daemon status

# View daemon logs
./dist/mcpli.js daemon logs

# Stop daemon
./dist/mcpli.js daemon stop -- node weather-server.js
```

#### Testing Different Configurations

Test with various server configurations:

```bash
# Test with environment variables
./dist/mcpli.js get-weather --location "London" -- API_KEY=test node weather-server.js

# Test with server arguments
./dist/mcpli.js get-weather --location "Tokyo" -- node weather-server.js --debug

# Test timeout configurations
./dist/mcpli.js get-weather --timeout=60 --location "Paris" -- node weather-server.js
```

## Architecture Overview

MCPLI consists of several key components:

### Core Components

- **`src/mcpli.ts`** - Main CLI entry point and command parsing
- **`src/daemon/`** - Daemon process management and IPC
  - `spawn.ts` - Daemon spawning and lifecycle
  - `lock.ts` - Process locking and daemon identity
  - `ipc.ts` - Inter-process communication
  - `wrapper.js` - Daemon wrapper process
- **`src/config.ts`** - Configuration management and environment variables

### Key Features

- **Daemon Management**: Persistent processes with hash-based identity
- **IPC Communication**: Unix sockets for client-daemon communication
- **Parameter Parsing**: JSON Schema-aware CLI argument parsing
- **Help Generation**: Dynamic help from MCP tool schemas
- **Timeout Management**: Configurable daemon and operation timeouts

## Code Standards

### TypeScript Guidelines

1. **Strict typing** - No `any` types, use proper interfaces
2. **Error handling** - Always handle errors gracefully
3. **Logging** - Use consistent error and debug logging
4. **Documentation** - Document public interfaces and complex logic

### Code Style

1. **Follow existing patterns** in the codebase
2. **Use descriptive names** for functions and variables
3. **Keep functions focused** - single responsibility principle
4. **Add JSDoc comments** for public APIs

### Testing Standards

When tests are added (future enhancement):

1. Test both daemon and stateless modes
2. Test various parameter types and edge cases
3. Test timeout behaviors
4. Test daemon isolation with different configurations
5. Test error handling and recovery

## Making Changes

### Before You Start

1. **Check existing issues** - See if your idea is already being discussed
2. **Open an issue** for significant changes to discuss approach
3. **Fork the repository** and create a feature branch

### Development Process

1. **Create a feature branch** from main:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the code standards

3. **Test thoroughly**:
   ```bash
   # Build and test
   npm run build
   npm run typecheck
   npm run lint

   # Manual testing with various MCP servers
   ./dist/mcpli.js --help -- node weather-server.js
   ```

4. **Update documentation** if you've added features or changed behavior

5. **Commit with clear messages**:
   ```bash
   git add .
   git commit -m "feat: add support for XYZ feature"
   ```

### Pull Request Guidelines

1. **Clear description** of what the PR does and why
2. **Link related issues** using keywords (closes #123)
3. **Include testing instructions** for reviewers
4. **Keep changes focused** - one feature/fix per PR
5. **Update CHANGELOG.md** with your changes

### Commit Message Format

Use conventional commits format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Build/tooling changesxw

## Code Quality Checklist

Before submitting a PR, ensure:

- [ ] Code builds without errors: `npm run build`
- [ ] TypeScript checks pass: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Manual testing with sample server works
- [ ] Documentation updated for new features
- [ ] CHANGELOG.md updated
- [ ] Commit messages follow convention
- [ ] PR description is clear and complete

## Getting Help

- **Issues**: Use GitHub issues for bugs and feature requests
- **Discussions**: Use GitHub discussions for questions
- **Code Review**: Maintainers will review PRs and provide feedback

## Code of Conduct

Please be respectful and constructive in all interactions. We want MCPLI to have a welcoming community for all contributors.

Key principles:
- **Be respectful** of different opinions and approaches
- **Be constructive** in feedback and suggestions
- **Be collaborative** - we're all working toward the same goal
- **Be patient** with new contributors and questions

Thank you for contributing to MCPLI! 🚀