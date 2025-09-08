# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0]

### Improvements
- Fixes issue where tool call timeouts were too aggressive
- Fixes bug where IPC timeout could be lower than tool timeout
- Default tool call  timeout is now 10 minutes
- Pass `--tool-timeout=<seconds>` to extend 
- Various fixes

## [0.1.3]

### Added
- Initial release of MCPLI
- Transform any stdio-based MCP server into a first-class CLI tool
- Persistent daemon architecture for stateful operations
- Natural CLI syntax with auto-generated help
- Standard shell composition with pipes and output redirection
- Flexible parameter syntax supporting all MCP data types
- Multiple daemon support with hash-based identity
- Configurable timeouts with environment variable support

## [1.0.0] - TBD

### Added
- Initial public release
