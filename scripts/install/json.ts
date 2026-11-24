// Strict JSON helpers. The installer reads and writes the Pi settings with these, keeping every string, null,
// number, and key order exactly. A file with comments or trailing commas is not strict JSON.
import { assertSurrogateEscapes, safeName } from './ordinal.ts';

/**
 * A JSON number held as the text the file wrote. System.Text.Json keeps a parsed number's text exactly, so 1.50 is
 * written back as 1.50 rather than as 1.5.
 */
export class JsonNumber {
  constructor(readonly raw: string) {}
}

/** The object a settings text holds. Text that is not strict JSON, or is not an object, throws. */
export function readStrictJsonObject(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  const parsed = parseStrictJsonText(text, 1024, { preserveNumbers: true });
  if (!parsed.ok) throw new Error('not strict JSON');
  const value = parsed.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('not a JSON object');
  }
  return value as Record<string, unknown>;
}

/** The indented text System.Text.Json writes. */
export function jsonText(value: unknown): string {
  return writeJsonValue(value, 2, 0);
}

/** The compact text of an entry. */
export function compactJson(value: unknown): string {
  return writeJsonCompact(value);
}

function writeJsonValue(value: unknown, indent: number, depth: number): string {
  if (value instanceof JsonNumber) return value.raw;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = ' '.repeat(indent * (depth + 1));
    const close = ' '.repeat(indent * depth);
    const items = value.map((item) => pad + writeJsonValue(item, indent, depth + 1));
    return `[\n${items.join(',\n')}\n${close}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    );
    if (entries.length === 0) return '{}';
    const pad = ' '.repeat(indent * (depth + 1));
    const close = ' '.repeat(indent * depth);
    const items = entries.map(
      ([key, item]) => `${pad}${JSON.stringify(key)}: ${writeJsonValue(item, indent, depth + 1)}`,
    );
    return `{\n${items.join(',\n')}\n${close}}`;
  }
  return 'null';
}

function writeJsonCompact(value: unknown): string {
  if (value instanceof JsonNumber) return value.raw;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(writeJsonCompact).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${writeJsonCompact(item)}`)
      .join(',')}}`;
  }
  return 'null';
}

/** The text an entry is compared by: a string by its value, anything else by its canonical JSON. */
export function jsonEntryKey(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `s:${value}`;
  return `j:${compactJson(value)}`;
}

/** The key of an entry read from the lock, which is a plain JSON value. */
export function jsonEntryKeyFromValue(value: unknown): string {
  return jsonEntryKey(value);
}

/** The value of one property of a JSON object, or null when the object has none. */
export function jsonProperty(root: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(root, key) ? root[key] : null;
}

/** Adds a property to a JSON object. Only a key the object lacks is added. */
export function setJsonProperty(root: Record<string, unknown>, key: string, value: unknown): void {
  root[key] = value;
}

/**
 * One Pi list in place. Each recorded entry accounts for one copy of itself: the installer removes that copy and
 * writes the entry again as its own. A copy the user wrote beside it stays. The list is created when absent.
 */
export function mergeJsonEntries(
  root: Record<string, unknown>,
  key: string,
  wanted: readonly string[],
  owned: readonly unknown[],
): string[] {
  let list = root[key];
  if (!Array.isArray(list)) {
    list = [];
    root[key] = list;
  }
  const entries = list as unknown[];
  const ownedKeys = new Set<string>();
  for (const entry of owned) {
    if (entry === null || entry === undefined) continue;
    const entryKey = jsonEntryKeyFromValue(entry);
    ownedKeys.add(entryKey);
    for (let index = 0; index < entries.length; index++) {
      if (jsonEntryKey(entries[index]) === entryKey) {
        entries.splice(index, 1);
        break;
      }
    }
  }
  const present = new Set(entries.map((entry) => jsonEntryKey(entry)));
  const added: string[] = [];
  for (const entry of wanted) {
    const entryKey = `s:${entry}`;
    if (ownedKeys.has(entryKey) || !present.has(entryKey)) {
      entries.push(entry);
      added.push(entry);
    }
  }
  return added;
}

/** Refuses an unpaired surrogate escape before a text is parsed. */
export { assertSurrogateEscapes };

/** The message for a duplicate JSON key. */
export function duplicateKeyMessage(key: string, at: string): string {
  return `duplicate key '${safeName(key)}' at ${at}`;
}

export type StrictParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'syntax' | 'depth' }
  | { ok: false; reason: 'duplicate'; duplicate: { key: string; at: string } };

/**
 * Parses JSON the way System.Text.Json does with comments and trailing commas disallowed, reporting a duplicate key
 * and a nesting depth over the limit as their own results. The value is a plain JSON value.
 */
export function parseStrictJsonText(
  text: string,
  maxDepth: number,
  options: { preserveNumbers?: boolean } = {},
): StrictParseResult {
  let index = 0;
  const length = text.length;

  class ParseError extends Error {
    constructor(readonly kind: 'syntax' | 'depth') {
      super(kind);
    }
  }
  class DuplicateError extends Error {
    constructor(
      readonly key: string,
      readonly at: string,
    ) {
      super('duplicate');
    }
  }

  const fail = (kind: 'syntax' | 'depth' = 'syntax'): never => {
    throw new ParseError(kind);
  };

  function skipWhitespace(): void {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index++;
      else break;
    }
  }

  function parseString(): string {
    const start = index;
    index++;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index++;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          fail('syntax');
        }
      }
      if (code === 0x5c) {
        index += 2;
        continue;
      }
      if (code < 0x20) fail('syntax');
      index++;
    }
    return fail('syntax');
  }

  function parseNumber(): number | JsonNumber {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = index;
    const found = match.exec(text);
    if (!found || found[0].length === 0) return fail('syntax');
    index += found[0].length;
    return options.preserveNumbers ? new JsonNumber(found[0]) : Number(found[0]);
  }

  function parseValue(depth: number, at: string): unknown {
    if (depth > maxDepth) fail('depth');
    skipWhitespace();
    if (index >= length) fail('syntax');
    const character = text[index] as string;
    if (character === '{') return parseObject(depth, at);
    if (character === '[') return parseArray(depth, at);
    if (character === '"') return parseString();
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  }

  function parseObject(depth: number, at: string): Record<string, unknown> {
    index++;
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (text[index] === '}') {
      index++;
      return result;
    }
    while (true) {
      skipWhitespace();
      if (text[index] !== '"') fail('syntax');
      const key = parseString();
      if (seen.has(key)) throw new DuplicateError(key, at);
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ':') fail('syntax');
      index++;
      result[key] = parseValue(depth + 1, `${at}.${safeName(key)}`);
      skipWhitespace();
      if (text[index] === ',') {
        index++;
        continue;
      }
      if (text[index] === '}') {
        index++;
        return result;
      }
      fail('syntax');
    }
  }

  function parseArray(depth: number, at: string): unknown[] {
    index++;
    const result: unknown[] = [];
    skipWhitespace();
    if (text[index] === ']') {
      index++;
      return result;
    }
    let item = 0;
    while (true) {
      result.push(parseValue(depth + 1, `${at}[${item}]`));
      item++;
      skipWhitespace();
      if (text[index] === ',') {
        index++;
        continue;
      }
      if (text[index] === ']') {
        index++;
        return result;
      }
      fail('syntax');
    }
  }

  try {
    skipWhitespace();
    if (index >= length) fail('syntax');
    const value = parseValue(0, 'root');
    skipWhitespace();
    if (index !== length) fail('syntax');
    return { ok: true, value };
  } catch (error) {
    if (error instanceof DuplicateError) {
      return { ok: false, reason: 'duplicate', duplicate: { key: error.key, at: error.at } };
    }
    if (error instanceof ParseError) return { ok: false, reason: error.kind };
    return { ok: false, reason: 'syntax' };
  }
}

/** Sorts every object key ordinally, keeping arrays in order, as the settings hash does. */
export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareOrdinal)) {
      result[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/** Compares two strings by UTF-16 code unit, as StringComparer.Ordinal does. */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
