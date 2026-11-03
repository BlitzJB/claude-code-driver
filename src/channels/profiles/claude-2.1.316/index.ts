// channels/profiles/claude-2.1.316/index.ts — assembles the 2.1.316 profile (DESIGN.md §1.2, §8). WP-00; never edited after Phase 0.
// It imports the five leaf files by their fixed export names; the leaf owners (WP-06: hooks, transcript; WP-07: screen, errors,
// commands) fill their files without touching this one.

import type { ClaudeProfile } from '../index.js';
import { commandsProfile } from './commands.js';
import { errorsProfile } from './errors.js';
import { hooksProfile } from './hooks.js';
import { screenStrings } from './screen.js';
import { transcriptProfile } from './transcript.js';
import { usageProfile } from './usage.js';

export const profile: ClaudeProfile = Object.freeze({
  version: '2.1.316',
  hooks: hooksProfile,
  transcript: transcriptProfile,
  screen: screenStrings,
  errors: errorsProfile,
  commands: commandsProfile,
  usage: usageProfile,
});
