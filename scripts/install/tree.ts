// Tree hashing and ownership records. A tree hash lists every entry, a link by its target and a file by its SHA-256,
// sorted by UTF-8 bytes, and hashes that text. The owned rule leaves out node_modules and .git at any depth; the legacy
// rule leaves out only a top-level node_modules, ignoring case.
import { chmodSync, lstatSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMaxstackLink, maxstackLinkTarget } from './links.ts';
import { convertToMaxstackPath, joinMaxstackPath } from './paths.ts';
import { ordinalEqual, ordinalIn, sortUtf8 } from './ordinal.ts';
import { getField, sha256FileOrNull, sha256Text, writeHost } from './util.ts';
import { S, type OwnedRecord } from './state.ts';
import { compactJson } from './json.ts';

export const WORKSPACE_INSTRUCTION_RUNTIME = 'workspace-instructions';

export interface TreeEntry {
  relative: string;
  full: string;
  link: string | null;
}

/** Whether a path is a link or a junction, which a walk lists and never follows. */
export function testReparsePoint(path: string): boolean {
  return isMaxstackLink(path);
}

/** Whether a relative path under the owned or legacy rule is left out of a tree hash. */
export function testTreeFolderExcluded(relative: string, rule: string): boolean {
  if (ordinalEqual(rule, 'legacy')) return /^node_modules$/i.test(relative);
  return /(^|\/)(node_modules|\.git)$/.test(relative);
}

/** Every entry under a root, with links listed and never followed. */
export function getTreeEntries(root: string, rule: string): TreeEntry[] {
  const rootFull = root.replace(/[\\/]+$/, '');
  const pending: string[] = [rootFull];
  const entries: TreeEntry[] = [];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let children: string[];
    try {
      children = readdirSync(directory, { withFileTypes: true }).map((entry) => join(directory, entry.name));
    } catch {
      continue;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const child of children) {
      let stats;
      try {
        stats = lstatSync(child);
      } catch {
        continue;
      }
      if (stats.isDirectory()) dirs.push(child);
      else files.push(child);
    }
    for (const child of dirs) {
      const relative = relativePath(rootFull, child);
      if (testReparsePoint(child)) {
        entries.push({ relative, full: child, link: maxstackLinkTarget(child) });
      } else if (!testTreeFolderExcluded(relative, rule)) {
        pending.push(child);
      }
    }
    for (const child of files) {
      const relative = relativePath(rootFull, child);
      if (testReparsePoint(child)) {
        entries.push({ relative, full: child, link: maxstackLinkTarget(child) });
      } else {
        entries.push({ relative, full: child, link: null });
      }
    }
  }
  return entries;
}

function relativePath(root: string, full: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalizedFull = full.replace(/[\\/]+$/, '');
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedFull.startsWith(prefix) ? normalizedFull.slice(prefix.length) : normalizedFull;
}

/** One line per entry: relative path, a tab, and the file hash or the word link and target. */
export function getEntryLines(entries: readonly TreeEntry[], prefix = ''): string[] {
  return entries.map((entry) => {
    const name = prefix ? `${prefix}/${entry.relative}` : entry.relative;
    if (entry.link !== null) return `${name}\tlink:${entry.link}`;
    return `${name}\t${sha256FileOrNull(entry.full) ?? ''}`;
  });
}

/** The SHA-256 of sorted lines, each with a trailing newline. */
export function getTreeLinesSha256(lines: readonly string[]): string {
  return sha256Text(`${sortUtf8(lines).join('\n')}\n`);
}

/** The owned hash of a folder. */
export function getTreeSha256(root: string): string {
  if (isMaxstackLink(root)) throw new Error(`Cannot hash owned folder '${root}' because it is a link.`);
  return getTreeLinesSha256(getEntryLines(getTreeEntries(root, 'owned')));
}

/** The legacy hash of a Claude child. */
export function getLegacyTreeSha256(root: string): string {
  if (isMaxstackLink(root)) throw new Error(`Cannot hash owned folder '${root}' because it is a link.`);
  return getTreeLinesSha256(getEntryLines(getTreeEntries(root, 'legacy')));
}

/** The owned hash a folder holds once the named items are copied from a layer root, or null when an item is missing. */
export function getItemsTreeSha256(root: string, items: readonly string[]): string | null {
  const lines: string[] = [];
  for (const item of items) {
    const name = item.replaceAll('\\', '/');
    if (testTreeFolderExcluded(name, 'owned')) continue;
    const source = joinMaxstackPath(root, item);
    let stats;
    try {
      stats = statSync(source);
    } catch {
      return null;
    }
    if (stats.isFile()) {
      lines.push(...getEntryLines([{ relative: name, full: source, link: null }]));
    } else if (stats.isDirectory()) {
      lines.push(...getEntryLines(getTreeEntries(source, 'owned'), name));
    } else {
      return null;
    }
  }
  return getTreeLinesSha256(lines);
}

/** The record of a prior owned file at a path, or null. */
export function getPriorOwnedFileRecord(path: string): OwnedRecord | null {
  if (S.priorOwned === null) return null;
  return (
    S.priorOwned.find(
      (record) => record !== null && ordinalEqual(record.path, path) && ordinalEqual(record.kind, 'file'),
    ) ?? null
  );
}

/** The record of a prior workspace-instruction file at a path, or null. */
export function getPriorWorkspaceInstructionRecord(path: string): OwnedRecord | null {
  if (S.priorOwned === null) return null;
  return (
    S.priorOwned.find(
      (record) =>
        record !== null &&
        ordinalEqual(record.path, path) &&
        ordinalEqual(record.kind, 'file') &&
        ordinalEqual(record.runtime, WORKSPACE_INSTRUCTION_RUNTIME),
    ) ?? null
  );
}

/** The runtime an owned path belongs to, or null. */
export function getOwnedRuntime(path: string): string | null {
  if (path.startsWith('opencode.jsonc') || path.startsWith('.opencode/')) return 'opencode';
  if (path.startsWith('.claude/plugins/')) return 'claude';
  if (ordinalIn(path, ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh'])) return 'copilot';
  if (path.startsWith('.maxstack/bin/pi.') || path.startsWith('.pi/')) return 'pi';
  if (path.startsWith('.agents/skills/') || ordinalEqual(path, '.codex/config.toml')) return 'codex';
  if (ordinalEqual(path, '.agents/hooks.json')) return 'antigravity';
  if (path.startsWith('.cursor/skills/') || ordinalEqual(path, '.cursor/hooks.json')) return 'cursor';
  if (ordinalEqual(path, '.pstack/pstack-t3-instances.json')) return 't3-gated-instances';
  return null;
}

/** The runtimes a record's path serves. A shared .agents skill uses runtimes, a legacy one uses runtime. */
export function getOwnedRuntimeClaims(record: OwnedRecord): string[] {
  const runtimes = getField(record, 'runtimes');
  if (runtimes !== null && runtimes !== undefined) return (runtimes as string[]) ?? [];
  const runtime = getField(record, 'runtime');
  if (runtime !== null && runtime !== undefined && !ordinalEqual(runtime, WORKSPACE_INSTRUCTION_RUNTIME)) {
    return [runtime as string];
  }
  const pathRuntime = getOwnedRuntime(record.path);
  return pathRuntime === null ? [] : [pathRuntime];
}

/** The identity of a record: its path, kind, and Pi key. */
export function getOwnedKey(record: OwnedRecord): string {
  return `${record.path}\t${record.kind}\t${getField(record, 'key') ?? ''}`;
}

/** The records in lock order: by path, kind, and key, by UTF-8 bytes. */
export function sortOwnedRecords(records: readonly (OwnedRecord | null)[]): OwnedRecord[] {
  const byKey = new Map<string, OwnedRecord>();
  for (const record of records) {
    if (record === null) continue;
    byKey.set(getOwnedKey(record), record);
  }
  return sortUtf8([...byKey.keys()]).map((key) => byKey.get(key) as OwnedRecord);
}

export interface NewOwnedRecordOptions {
  path: string;
  kind: string;
  sha256?: string | null;
  target?: string | null;
  key?: string | null;
  entries?: unknown[] | null;
  createdKey?: boolean;
  runtime?: string | null;
  layers?: readonly string[];
  runtimeClaims?: readonly string[];
  role?: string | null;
}

/** One record of the ownership list, in the field order the lock has always used. */
export function newOwnedRecord(options: NewOwnedRecordOptions): OwnedRecord {
  const record: OwnedRecord = { path: options.path, kind: options.kind };
  if (options.kind === 'link') {
    record.target = options.target ?? null;
  } else if (options.kind === 'json-entries') {
    record.key = options.key ?? undefined;
    record.entries = options.entries ?? [];
    if (options.createdKey) record.createdKey = true;
  } else {
    record.sha256 = options.sha256 ?? null;
  }
  if ((options.runtimeClaims ?? []).length > 0) {
    record.runtimes = sortUtf8((options.runtimeClaims ?? []).filter(Boolean));
  } else {
    record.runtime = options.runtime ?? null;
  }
  record.layers = sortUtf8((options.layers ?? []).filter(Boolean));
  if (options.role !== null && options.role !== undefined) record.role = options.role;
  return record;
}

/** The role of a backup record. A lock from before roles names none; a plain .bak is the original. */
export function getBackupRole(record: OwnedRecord): string | null {
  const role = getField(record, 'role');
  if (role !== null && role !== undefined) return role as string;
  if (/\.bak$/.test(record.path)) return 'original';
  return null;
}

/** The role a backup had in the previous lock, or user when the previous lock never named it. */
export function getPriorBackupRole(relative: string): string {
  if (S.priorOwned === null) return 'user';
  const prior = S.priorOwned.find(
    (record) => record !== null && ordinalEqual(record.path, relative) && ordinalEqual(record.kind, 'file'),
  );
  if (!prior) return 'user';
  return getBackupRole(prior) ?? 'user';
}

/** The SHA-256 the previous lock records for the original backup of a file, or null. */
export function getPriorOriginalSha(relative: string): string | null {
  if (S.priorOwned === null) return null;
  const prior = S.priorOwned.find(
    (record) =>
      record !== null &&
      ordinalEqual(record.path, `${relative}.bak`) &&
      ordinalEqual(record.kind, 'file') &&
      ordinalEqual(getBackupRole(record), 'original'),
  );
  return prior ? (prior.sha256 ?? null) : null;
}

export interface BackupTarget {
  action: 'none' | 'original' | 'edited' | 'duplicate';
  path: string | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An existing backup of a file whose bytes have the given hash, or null. */
export function getBackupWithSha(path: string, sha256: string): string | null {
  const folder = dirname(path);
  const leaf = path.slice(path.lastIndexOf('/') + 1);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${escapeRegExp(leaf)}\\.bak(\\.\\d+)?$`);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const full = join(folder, name);
    try {
      if (sha256FileOrNull(full) === sha256) return full;
    } catch {
      // ignore
    }
  }
  return null;
}

/** The first free numbered backup path. */
export function getNextBackupPath(path: string): string {
  for (let number = 1; ; number++) {
    const candidate = `${path}.bak.${number}`;
    try {
      statSync(candidate);
    } catch {
      return candidate;
    }
  }
}

/** The backup an apply takes before it replaces a file with its text. */
export function getBackupTarget(
  path: string,
  lastSha: string | null,
  newText: string,
  created: boolean,
  recordedOriginalSha: string | null = null,
): BackupTarget {
  const none: BackupTarget = { action: 'none', path: null };
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return none;
  }
  if (!stats.isFile()) return none;
  if (readFileSync(path, 'utf8').trim() === newText.trim()) return none;
  const current = sha256FileOrNull(path);
  if (lastSha && current === lastSha) return none;
  const original = `${path}.bak`;
  const hasOriginal = (() => {
    try {
      return statSync(original).isFile();
    } catch {
      return false;
    }
  })();
  if (!hasOriginal && recordedOriginalSha !== null && current === recordedOriginalSha) {
    return { action: 'original', path: original };
  }
  if (lastSha === null) {
    if (created) return none;
    if (!hasOriginal) return { action: 'original', path: original };
    return { action: 'original', path: getNextBackupPath(path) };
  }
  const earlier = current === null ? null : getBackupWithSha(path, current);
  if (earlier !== null) return { action: 'duplicate', path: earlier };
  return { action: 'edited', path: getNextBackupPath(path) };
}

/** The file records of one file's backups: the original, every numbered copy on disk, and the copy this apply writes. */
export function getBackupRecordsFor(relative: string, target: BackupTarget, runtime: string | null): OwnedRecord[] {
  const full = joinMaxstackPath(S.workspace, convertToMaxstackPath(relative));
  const folder = dirname(full);
  const leaf = full.slice(full.lastIndexOf('/') + 1);
  const paths: string[] = [];
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    names = [];
  }
  const pattern = new RegExp(`^${escapeRegExp(leaf)}\\.bak(\\.\\d+)?$`);
  for (const name of names) {
    if (pattern.test(name)) paths.push(join(folder, name));
  }
  let targetPath: string | null = null;
  if (ordinalIn(target.action, ['original', 'edited'])) targetPath = target.path;
  if (targetPath !== null && !paths.includes(targetPath)) paths.push(targetPath);
  const records: OwnedRecord[] = [];
  for (const backupPath of paths) {
    const relativeBackup = relativePath(S.workspace, backupPath);
    let role: string | null;
    let sha: string | null;
    if (ordinalEqual(backupPath, targetPath as string)) {
      role = ordinalEqual(target.action, 'original') ? 'original' : 'edited';
      sha = sha256FileOrNull(full);
    } else {
      role = getPriorBackupRole(relativeBackup);
      sha = sha256FileOrNull(backupPath);
    }
    const record = newOwnedRecord({ path: relativeBackup, kind: 'file', sha256: sha, runtime, role });
    record.backup = true;
    records.push(record);
  }
  return records;
}

/** Deletes a file, or a folder and everything in it. A link is removed as a link. */
export function removeOwnedTree(path: string): void {
  // A link is removed as a link even when its target is already gone: statSync would fail on the dangling link.
  if (isMaxstackLink(path)) {
    removeLink(path);
    return;
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    for (const child of readdirSync(path)) removeOwnedTree(join(path, child));
    try {
      rmdirSync(path);
    } catch {
      // ignore
    }
  } else {
    try {
      chmodSync(path, 0o644);
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

function removeLink(path: string): void {
  try {
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
  } catch {
    // ignore
  }
}

/** The named paths that exist on disk, in their given order. */
export function selectPresentPaths(paths: readonly (string | null)[], kind: 'Container' | 'Leaf'): string[] {
  const present: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const full = joinMaxstackPath(S.workspace, convertToMaxstackPath(path));
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (kind === 'Container' ? stats.isDirectory() : stats.isFile()) present.push(path);
  }
  return present;
}

/** The candidates that exist now and either were not there before this apply, or were recorded as created. */
export function getCreatedPaths(
  candidates: readonly string[],
  prior: readonly string[],
  existedBefore: readonly string[],
  kind: 'dir' | 'file',
): string[] {
  const seen = new Set<string>();
  const created: string[] = [];
  for (const path of [...candidates, ...prior]) {
    if (seen.has(path)) continue;
    seen.add(path);
    const full = joinMaxstackPath(S.workspace, convertToMaxstackPath(path));
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (kind === 'dir' ? !stats.isDirectory() : !stats.isFile()) continue;
    if (prior.includes(path) || !existedBefore.includes(path)) created.push(path);
  }
  return sortUtf8(created);
}

/** The layer.json object of a layer root, or null. */
export function readLayerJson(root: string): Record<string, unknown> | null {
  const path = joinMaxstackPath(root, 'layer.json');
  try {
    if (!statSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The canonical text of one Pi entry, so a string or an object compares by what it says. */
export function getPiEntryKey(entry: unknown): string {
  return compactJson(entry);
}

/** Says a file was kept because it changed since the last apply. */
export function writeKeptChanged(path: string): void {
  writeHost(`Kept ${path}: it changed since the last apply.`);
}
