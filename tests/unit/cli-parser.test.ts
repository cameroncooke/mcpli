import { describe, it } from 'vitest';

// Intentionally skipped: mcpli.ts executes main() on import, so we avoid importing internals here.
// CLI argument parsing behavior is covered in e2e tests (tests/e2e/cli.test.ts).

describe.skip('cli parser unit tests', () => {
  it('parses arguments and validates schema', () => {
    // Covered by e2e CLI tests using real execution path.
  });
});