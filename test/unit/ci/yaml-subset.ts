// test/unit/ci/yaml-subset.ts — a small YAML reader for the CI workflow tests (WP-CI). The package has zero runtime
// dependencies and no YAML parser in devDependencies, so the tests read `.github/workflows/*.yml` with this subset reader:
// block mappings, block sequences (incl. `- key: value` items), `|`/`|-`/`>` block scalars, flow sequences `[a, 'b']`,
// single/double-quoted and plain scalars, and comments. Anything outside the subset throws, so a workflow edit that leaves
// the subset fails loudly instead of being misread. Keys stay strings (GitHub reads `on:` as the string "on", unlike YAML 1.1).

export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };
export type YamlMap = Record<string, Yaml>;

interface Line {
  readonly no: number;
  indent: number;
  text: string; // content after the indent, comment stripped, right-trimmed
  readonly raw: string;
}

export class YamlSubsetError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${String(line)}: ${message}`);
    this.name = 'YamlSubsetError';
  }
}

/** Removes a trailing `# comment` that is outside quotes (a `#` must follow whitespace or start the text). */
export function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && text.charAt(i + 1) === "'") i++;
        else quote = null;
      } else if (quote === '"' && c === '\\') i++;
      continue;
    }
    if ((c === "'" || c === '"') && (i === 0 || /[\s[,:{-]/.test(text.charAt(i - 1)))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text.charAt(i - 1)))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/** Index of the `:` that separates a mapping key from its value, or -1. */
function keyColon(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (i === 0 && (c === "'" || c === '"')) {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') return -1;
    if (c === ':' && (i + 1 === text.length || text.charAt(i + 1) === ' ')) return i;
  }
  return -1;
}

function unquote(s: string, no: number): string {
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlSubsetError(`unterminated single-quoted scalar ${s}`, no);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlSubsetError(`unterminated double-quoted scalar ${s}`, no);
    return s.slice(1, -1).replace(/\\(["\\/nrt0])/g, (_m, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case '0':
          return '\0';
        default:
          return ch;
      }
    });
  }
  return s;
}

function splitFlow(inner: string, no: number): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of inner) {
    if (quote !== null) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ',') {
      parts.push(cur.trim());
      cur = '';
    } else if (c === '[' || c === ']' || c === '{' || c === '}') {
      throw new YamlSubsetError('nested flow collections are outside the subset', no);
    } else cur += c;
  }
  if (quote !== null) throw new YamlSubsetError('unterminated quote in flow sequence', no);
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

/** A scalar or a one-level flow sequence. Plain `true`/`false`/`null`/integers are typed; everything else is a string. */
export function parseScalar(text: string, no = 0): Yaml {
  const s = text.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlSubsetError(`unterminated flow sequence ${s}`, no);
    return splitFlow(s.slice(1, -1), no).map((p) => parseScalar(p, no));
  }
  if (s.startsWith('{')) throw new YamlSubsetError('flow mappings are outside the subset', no);
  if (s.startsWith("'") || s.startsWith('"')) return unquote(s, no);
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('!'))
    throw new YamlSubsetError(`anchors/tags are outside the subset: ${s}`, no);
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(source: string): Yaml {
  const lines: Line[] = source.split(/\r?\n/).map((raw, i) => {
    if (/^\s*\t/.test(raw)) throw new YamlSubsetError('tab indentation is not YAML', i + 1);
    const indent = raw.length - raw.trimStart().length;
    return { no: i + 1, indent, text: stripComment(raw.slice(indent)), raw };
  });
  let pos = 0;

  const isContent = (l: Line): boolean => l.text !== '';
  const peek = (): Line | undefined => {
    while (pos < lines.length) {
      const l = lines[pos];
      if (l !== undefined && isContent(l)) return l;
      pos++;
    }
    return undefined;
  };
  const isSeqItem = (t: string): boolean => t === '-' || t.startsWith('- ');

  function blockScalar(parentIndent: number, header: string, no: number): string {
    if (!/^[|>][-+]?$/.test(header)) throw new YamlSubsetError(`unsupported block scalar header ${header}`, no);
    const folded = header.startsWith('>');
    const chomp = header.length > 1 ? header.charAt(1) : '';
    const body: string[] = [];
    let contentIndent = -1;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l === undefined) break;
      const blank = l.raw.trim() === '';
      if (!blank && l.indent <= parentIndent) break;
      if (!blank && contentIndent < 0) contentIndent = l.indent;
      body.push(blank ? '' : l.raw.slice(contentIndent));
      pos++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const text = folded ? body.join(' ').replace(/ {2,}/g, ' ') : body.join('\n');
    if (chomp === '-') return text;
    return text === '' ? '' : `${text}\n`;
  }

  function value(rest: string, ownerIndent: number, no: number): Yaml {
    if (rest !== '') {
      if (rest.startsWith('|') || rest.startsWith('>')) return blockScalar(ownerIndent, rest, no);
      return parseScalar(rest, no);
    }
    const next = peek();
    if (next === undefined) return null;
    if (next.indent > ownerIndent) return block(next.indent);
    if (next.indent === ownerIndent && isSeqItem(next.text)) return sequence(ownerIndent);
    return null;
  }

  function mapping(indent: number): YamlMap {
    const out: YamlMap = {};
    for (let l = peek(); l?.indent === indent && !isSeqItem(l.text); l = peek()) {
      const c = keyColon(l.text);
      if (c < 0) throw new YamlSubsetError(`expected "key: value", got ${l.text}`, l.no);
      const keyText = l.text.slice(0, c).trim();
      const key = unquote(keyText, l.no);
      if (Object.hasOwn(out, key)) throw new YamlSubsetError(`duplicate key ${key}`, l.no);
      const rest = l.text.slice(c + 1).trim();
      pos++;
      out[key] = value(rest, indent, l.no);
    }
    const after = peek();
    if (after !== undefined && after.indent > indent) throw new YamlSubsetError(`unexpected indentation`, after.no);
    return out;
  }

  function sequence(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (let l = peek(); l?.indent === indent && isSeqItem(l.text); l = peek()) {
      const item = l.text === '-' ? '' : l.text.slice(2);
      const lead = item.length - item.trimStart().length;
      const content = item.trimStart();
      if (content === '') {
        pos++;
        out.push(value('', indent, l.no));
      } else if (keyColon(content) > 0 && !content.startsWith('[')) {
        // `- key: value` starts a mapping whose keys sit at the item's content column.
        l.indent = indent + 2 + lead;
        l.text = content;
        out.push(mapping(l.indent));
      } else {
        pos++;
        out.push(content.startsWith('|') || content.startsWith('>') ? blockScalar(indent, content, l.no) : parseScalar(content, l.no));
      }
    }
    return out;
  }

  function block(indent: number): Yaml {
    const l = peek();
    if (l === undefined) return null;
    return isSeqItem(l.text) ? sequence(indent) : mapping(indent);
  }

  const first = peek();
  if (first === undefined) return null;
  if (first.indent !== 0) throw new YamlSubsetError('the document must start at column 0', first.no);
  const doc = block(0);
  const rest = peek();
  if (rest !== undefined) throw new YamlSubsetError(`trailing content: ${rest.text}`, rest.no);
  return doc;
}

// ---- typed accessors for the tests --------------------------------------------------------------------------------------

export function isMap(v: Yaml | undefined): v is YamlMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asMap(v: Yaml | undefined, what: string): YamlMap {
  if (!isMap(v)) throw new Error(`${what}: expected a mapping, got ${JSON.stringify(v)}`);
  return v;
}

export function asList(v: Yaml | undefined, what: string): Yaml[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected a sequence, got ${JSON.stringify(v)}`);
  return v;
}

export function asString(v: Yaml | undefined, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what}: expected a string, got ${JSON.stringify(v)}`);
  return v;
}
