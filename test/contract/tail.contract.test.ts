// The TranscriptTail contract run against both the fake world (FakeTailFs + ManualClock) and the real node:fs (DESIGN.md §2.7
// "Fakes": every L0 WP runs the shared contract suite against both).
import { defineTailContract, makeFakeWorld, makeRealWorld } from './tail.contract.js';

defineTailContract('FakeTailFs + ManualClock', () => makeFakeWorld());
defineTailContract('node:fs + real clock', () => makeRealWorld());
