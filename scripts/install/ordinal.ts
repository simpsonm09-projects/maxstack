// Ordinal text rules for the installer. Every name, keyword, spec, url, path text, and lock value is
// compared ordinally, and every value that enters from outside is refused when it holds a control, a
// format character, a line or paragraph separator, or an unpaired surrogate.

/** Whether two values are the same string, ordinally. A non-string equals nothing. */
export function ordinalEqual(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && left === right;
}

/** Whether two field values are the same: two nullish values are the same, a null and a string are not. */
export function ordinalSame(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  return ordinalEqual(left, right);
}

/** Whether a value is one of a set of names, ordinally. */
export function ordinalIn(value: unknown, set: readonly unknown[] | undefined | null): boolean {
  for (const item of set ?? []) if (ordinalEqual(value, item)) return true;
  return false;
}

/** The distinct strings, in their first order. */
export function ordinalUnique(values: readonly unknown[] | undefined | null): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values ?? []) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (!seen.has(text)) {
      seen.add(text);
      unique.push(text);
    }
  }
  return unique;
}

/** The strings in ordinal (UTF-16 code unit) order. */
export function ordinalSorted(values: readonly unknown[] | undefined | null): string[] {
  return (values ?? [])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isUnpairedSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    return !(next >= 0xdc00 && next <= 0xdfff);
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const prev = text.charCodeAt(index - 1);
    return !(prev >= 0xd800 && prev <= 0xdbff);
  }
  return false;
}

/** The index of the first character in a text that is not allowed, or -1. A valid pair is one character. */
export function findBoundaryIndex(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
    }
    if (isUnpairedSurrogate(text, index)) return index;
    if (UNSAFE.test(text[index] as string)) return index;
  }
  return -1;
}

/** The one safe-name escape: each unsafe character becomes \uXXXX, and a text over 260 is cut with an ellipsis. */
export function safeName(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  let display = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        display += text[index] + text[index + 1];
        index++;
        continue;
      }
    }
    if (isUnpairedSurrogate(text, index) || UNSAFE.test(text[index] as string)) {
      display += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      display += text[index];
    }
  }
  if (display.length <= 260) return display;
  const cut = display.charCodeAt(259) >= 0xd800 && display.charCodeAt(259) <= 0xdbff ? 259 : 260;
  return `${display.slice(0, cut)}...`;
}

/** Whether a text holds only characters a name or value may hold. */
export function boundaryText(text: unknown): boolean {
  return typeof text !== 'string' || findBoundaryIndex(text) < 0;
}

/** Throws when a name or value holds a character it may not hold. */
export function assertBoundaryText(text: unknown, subject: string): void {
  if (typeof text !== 'string') return;
  const index = findBoundaryIndex(text);
  if (index < 0) return;
  const code = `\\u${text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  throw new Error(
    `${safeName(subject)} '${safeName(text)}' holds the character ${code}, which a name or value may not hold.`,
  );
}

/** Checks every name and every string in a parsed document. */
export function assertTextBoundaryTree(value: unknown, where: string): void {
  if (typeof value === 'string') {
    assertBoundaryText(value, where);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTextBoundaryTree(item, `${where}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertBoundaryText(key, `${where} key`);
      assertTextBoundaryTree(child, `${where}.${safeName(key)}`);
    }
  }
}

const UNPAIRED_SURROGATE_ESCAPE =
  /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/;

/** Refuses an unpaired surrogate escape in raw JSON text, which the reader would turn into U+FFFD. */
export function assertSurrogateEscapes(text: string | null | undefined, where: string): void {
  if (!text) return;
  if (UNPAIRED_SURROGATE_ESCAPE.test(text)) {
    throw new Error(`${where} holds an unpaired surrogate escape, which a name or value may not hold.`);
  }
}

/** Whether a row's path names a layer by a whole path segment or a dash-suffixed file name. */
export function skippedLabel(label: string, layers: readonly string[]): boolean {
  for (const layer of layers) {
    const escaped = layer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[\\\\/"])${escaped}(?=$|[\\\\/"\\s\\-.\\]])`).test(label)) return true;
  }
  return false;
}

/** Whether two strings are equal ignoring case, ordinally. */
export function ordinalEqualIgnoreCase(left: unknown, right: unknown): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/** Whether a value is the boolean true. */
export function isTrue(value: unknown): boolean {
  return value === true;
}

/** Compares two strings by their UTF-8 bytes. */
export function compareUtf8Bytes(left: string, right: string): number {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return Buffer.compare(a, b);
}

/** The strings in UTF-8 byte order. */
export function sortUtf8(values: readonly unknown[] | undefined | null): string[] {
  return (values ?? [])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .sort(compareUtf8Bytes);
}
