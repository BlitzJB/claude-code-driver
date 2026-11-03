// platform/process/fake-claude-binary.ts — ClaudeBinaryPort fake (version mismatch, logged out, non-firstParty provider).
import type { ClaudeBinaryPort } from '../ports.js';
import { ClaudeAuthStatusUnreadable } from './errors.js';

export interface FakeClaudeBinaryOptions {
  exe?: string | undefined;
  via?: 'option' | 'consumer' | 'package' | 'path';
  version?: string;
  auth?: { loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string } | 'timeout' | 'unparseable';
}

export class FakeClaudeBinary implements ClaudeBinaryPort {
  exe: string | undefined;
  via: 'option' | 'consumer' | 'package' | 'path';
  versionString: string;
  auth: NonNullable<FakeClaudeBinaryOptions['auth']>;
  readonly calls: { op: 'resolve' | 'version' | 'authStatus'; arg?: string; env?: Readonly<Record<string, string>> }[] = [];

  constructor(o: FakeClaudeBinaryOptions = {}) {
    this.exe = 'exe' in o ? o.exe : '/fake/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
    this.via = o.via ?? 'consumer';
    this.versionString = o.version ?? '2.1.316';
    this.auth = o.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };
  }

  resolve(option?: string): Promise<{ exe: string; via: 'option' | 'consumer' | 'package' | 'path' } | undefined> {
    this.calls.push(option === undefined ? { op: 'resolve' } : { op: 'resolve', arg: option });
    if (option !== undefined) return Promise.resolve(option === this.exe ? { exe: option, via: 'option' } : undefined);
    return Promise.resolve(this.exe === undefined ? undefined : { exe: this.exe, via: this.via });
  }

  version(exe: string, env: Readonly<Record<string, string>>): Promise<string> {
    this.calls.push({ op: 'version', arg: exe, env });
    return Promise.resolve(this.versionString);
  }

  authStatus(
    exe: string,
    env: Readonly<Record<string, string>>,
  ): Promise<{ loggedIn: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string }> {
    this.calls.push({ op: 'authStatus', arg: exe, env });
    if (this.auth === 'timeout') return Promise.reject(new ClaudeAuthStatusUnreadable('timeout', null));
    if (this.auth === 'unparseable') return Promise.reject(new ClaudeAuthStatusUnreadable('unparseable', 1));
    return Promise.resolve({ ...this.auth });
  }
}
