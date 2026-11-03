// model/logger.ts — operator logger shape (DESIGN.md §1.2, §2.12; api-layering.md §8.1).
// Structured fields only; never prompt or tool content.

export type LogFields = Record<string, unknown>;
export interface Logger {
  debug(m: string, f?: LogFields): void;
  info(m: string, f?: LogFields): void;
  warn(m: string, f?: LogFields): void;
  error(m: string, f?: LogFields): void;
}
