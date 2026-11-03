// test/setup/has-assertions.ts — vitest setup for the `unit` and `kernel` projects (DESIGN.md §6.1, rev 2 §10 D7):
// every test must make at least one assertion, so coverage cannot be bought with assertion-free tests.
import { beforeEach, expect } from 'vitest';

beforeEach(() => {
  expect.hasAssertions();
});
