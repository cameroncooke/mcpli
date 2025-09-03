# Security Overview

This document provides a high‑level overview of the security characteristics of MCPLI for end users. It is intentionally non‑exhaustive and avoids operational details that could aid misuse. MCPLI prioritizes secure defaults, defense‑in‑depth, and privacy‑preserving behavior while remaining practical for local development and automation.

## Goals and Scope

- Provide confidence that MCPLI’s default operation is safe and robust for local use.
- Describe protections without revealing sensitive implementation specifics.
- Clarify responsibilities that remain with users and MCP server authors.

MCPLI is not a sandbox. It orchestrates and talks to MCP servers you choose to run. Trust and secure those servers as you would other local tooling.

## Core Protections

- Process Isolation and Lifecycle
  - Each unique MCP server configuration runs in its own long‑lived daemon, isolated per project directory.
  - Daemons auto‑shut down after periods of inactivity to free resources.
  - The daemon verifies its computed identity before starting, preventing accidental or forged mismatches.

- Local IPC Security
  - Communication uses private, local IPC channels with restrictive permissions.
  - Connection‑level controls enforce short handshake/idleness timeouts and cap concurrent clients.
  - Message‑size safety limits prevent runaway memory use; oversize requests are rejected.

- Input and Data Handling
  - CLI environment variables after `--` are parsed with strict rules and validated names.
  - Tool parameters are parsed according to schema where available; JSON inputs are sanitized to remove dangerous prototype keys.
  - Only the explicitly provided server environment (after `--`) influences daemon identity, avoiding accidental coupling to ambient shell state.

- Filesystem and Permissions
  - Project and runtime artifacts are written under private, per‑project locations using restrictive permissions.
  - Temporary and metadata files are created atomically and cleaned up safely.
  - Socket cleanup only removes known socket/symlink paths to avoid accidental deletion of regular files.

- Subprocess and Environment Safety
  - Subprocesses are launched without invoking a shell, reducing command‑injection risk.
  - Control/diagnostic variables are kept internal and are not propagated to your MCP server’s environment.

- Logging and Privacy
  - Diagnostic logging avoids exposing secrets and is designed for local development observability.
  - No network logging or telemetry is performed by MCPLI.

- Secure Defaults and Quality Gates
  - Modern runtime requirements and strict lint/type rules reduce unsafe coding patterns.
  - Automated tests exercise key safety behavior (e.g., input sanitation and IPC limits).

## User Responsibilities

- Run trusted MCP servers and review their behavior; MCPLI does not sandbox server code.
- Avoid passing secrets via command line where they could be exposed by your shell history.
- Keep MCPLI, Node.js, and your OS up to date.
- Do not run MCPLI or servers with elevated privileges unless strictly necessary.

## Reporting Vulnerabilities

Please use GitHub’s private Security Advisories to report potential vulnerabilities. Avoid filing public issues for security‑sensitive reports. We appreciate responsible disclosure and will work with you to triage and remediate.

## Changes and Versioning

This overview focuses on principles and user‑facing guarantees rather than exact implementation details. Internals may evolve to strengthen defenses without changing the guarantees stated here.

