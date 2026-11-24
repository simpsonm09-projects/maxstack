// Workspace discovery: -Workspace, MAXSTACK_WORKSPACE, the nearest marker from the current directory upward, then the
// script's own layout. An explicit or environment value never falls through to a later source.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { findBoundaryIndex, ordinalEqualIgnoreCase, safeName } from './ordinal.ts';
import {
  joinMaxstackPath,
  maxstackAbsolutePath,
  maxstackPathEqual,
  maxstackPathInside,
  pathPlatform,
  type Platform,
} from './paths.ts';
import { isMaxstackLink } from './links.ts';

export const MARKER_NAMES = ['maxstack.settings.json', 'stack.lock.json'];

export interface WorkspaceResolution {
  workspace: string;
  origin: string;
  warning: boolean;
  note: string | null;
}

function hasNoControlCharacters(path: string, name: string): void {
  const index = findBoundaryIndex(path);
  if (index < 0) return;
  const character = path[index] as string;
  const shown = safeName(path);
  const code = character.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdfff) {
    throw new Error(
      `${name} path contains a character that reorders or splits a line: ${shown}. Give a plain path.`,
    );
  }
  // Control characters are refused as such; a line or paragraph separator falls through to the line rule below.
  if (/\p{Cc}/u.test(character)) {
    throw new Error(`${name} path contains control characters: ${shown}`);
  }
  if (/\p{Cf}/u.test(character)) {
    const bidi =
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (!bidi) {
      throw new Error(
        `${name} path contains a format character, which a path may not hold: ${shown}. Give a plain path.`,
      );
    }
  }
  throw new Error(
    `${name} path contains a character that reorders or splits a line: ${shown}. Give a plain path.`,
  );
}

/** Refuses a path by its text before any filesystem call. */
export function assertMaxstackPathText(path: string, name: string): void {
  hasNoControlCharacters(path, name);
  const safePath = safeName(path);
  if (/^[\\/]{2}[?.][\\/]/.test(path)) {
    throw new Error(
      `${name} path uses a device prefix (\\\\?\\ or \\\\.\\): ${safePath}. Give a drive path.`,
    );
  }
  if (/^[\\/]{2}/.test(path)) {
    throw new Error(
      `${name} path is a UNC path: ${safePath}. Workspace discovery reads only local folders. Give a drive path.`,
    );
  }
}

function shortNameSegment(parent: string, segment: string): boolean {
  if (!/^[^~]{1,6}~\d+(\.[^.]{0,3})?$/.test(segment)) return false;
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return true;
  return !readdirSync(parent).some((name) => name === segment);
}

/** The 8.3 rule applies to a path the user supplied. */
export function assertMaxstackShortNames(fullPath: string, name: string): void {
  // Build each parent from the path root, so a POSIX path keeps its leading separator and the existence check reads the
  // real folder. PowerShell builds the prefix with a backslash, which only lines up on Windows.
  const root = parse(fullPath).root;
  let parent = root;
  for (const segment of fullPath.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (shortNameSegment(parent, segment)) {
      throw new Error(
        `${name} path has an 8.3 short name (${safeName(segment)}): ${safeName(fullPath)}. Give the long path.`,
      );
    }
    parent = join(parent, segment);
  }
}

/** Whether a folder is under .git, a layer cache, or a layer checkout. */
export function isMaxstackInternalLocation(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    if (ordinalEqualIgnoreCase(segments[index], '.git')) return true;
    if (index + 1 < segments.length && segmentPair(segments[index] as string, segments[index + 1] as string)) {
      return true;
    }
  }
  return false;
}

function segmentPair(first: string, second: string): boolean {
  if (ordinalEqualIgnoreCase(first, '.claude') && ordinalEqualIgnoreCase(second, 'cache')) {
    return true;
  }
  return (
    ordinalEqualIgnoreCase(first, 'projects') &&
    (ordinalEqualIgnoreCase(second, 'repos') || ordinalEqualIgnoreCase(second, 'worktrees'))
  );
}

/** The folder that holds the running scripts folder: the maxstack checkout this installer belongs to. */
export function maxstackRepoRoot(scriptRoot: string): string | null {
  const scriptDirectory = resolve(scriptRoot);
  if (basename(scriptDirectory).toLowerCase() !== 'scripts') return null;
  const repo = dirname(scriptDirectory);
  if (repo === dirname(repo)) return null;
  return repo;
}

/** A maxstack checkout holds the layer manifest and this installer. */
export function isMaxstackCheckout(folder: string): boolean {
  if (!folder) return false;
  return (
    existsSync(join(folder, 'layers.json')) &&
    statSync(join(folder, 'layers.json')).isFile() &&
    existsSync(join(folder, 'scripts', 'install', 'main.ts'))
  );
}

/** Whether a folder is the running checkout, lies under it, is a maxstack checkout, or is its workspace folder. */
export function isMaxstackCheckoutLocation(path: string, repoRoot: string | null | undefined): boolean {
  if (repoRoot && maxstackPathInside(path, repoRoot)) return true;
  const trimmed = path.replace(/[\\/]+$/, '');
  if (isMaxstackCheckout(trimmed)) return true;
  const leaf = basename(trimmed);
  const parent = dirname(trimmed);
  return ordinalEqualIgnoreCase(leaf, 'workspace') && isMaxstackCheckout(parent);
}

/** The folder a path finally names, with a junction or symbolic link followed. */
export function maxstackFinalDirectory(path: string): string {
  const final = realpathSync(path);
  return final.replace(/[\\/]+$/, '') || '/';
}

function maxstackFullPath(
  path: string,
  name: string,
  currentDirectory: string,
  platform?: Platform,
): string {
  assertMaxstackPathText(path, name);
  const safePath = safeName(path);
  const platformName = pathPlatform(platform);
  const windows = ordinalEqualIgnoreCase(platformName, 'Windows');
  if (windows && isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path) && !/^\\\\/.test(path)) {
    const kind = /^[A-Za-z]:/.test(path) ? 'drive-relative' : 'root-relative';
    throw new Error(
      `${name} path is ${kind}, so it would resolve against the process location: ${safePath}. Give a full path with a drive letter.`,
    );
  }
  let value = path;
  if (!maxstackAbsolutePath(value, platformName)) {
    value = joinMaxstackPath(maxstackCurrentDirectory(currentDirectory, name), value, platformName);
  }
  let full: string;
  try {
    full = resolve(value).replace(/[\\/]+$/, '') || '/';
  } catch {
    throw new Error(`${name} path is invalid: ${safePath}`);
  }
  assertMaxstackShortNames(full, name);
  return full;
}

/** Whether a path is a drive or share root. */
export function maxstackDriveRoot(path: string): boolean {
  if (path === '/') return true;
  return maxstackPathEqual(path, dirname(path));
}

/** Refuses a workspace target and returns the path as given. */
export function assertMaxstackWorkspaceTarget(
  path: string,
  source: string,
  repoRoot: string | null | undefined,
): string {
  assertMaxstackPathText(path, source);
  const safePath = safeName(path);
  const missing = `${source} target does not exist or is not a directory: ${safePath}`;
  if (maxstackDriveRoot(path)) {
    throw new Error(`${source} target is a drive root, not a workspace: ${safePath}. Give a folder under it.`);
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(missing);
  let final: string;
  try {
    final = maxstackFinalDirectory(path);
  } catch {
    throw new Error(`${source} target could not be checked: ${safePath}`);
  }
  if (!existsSync(final) || !statSync(final).isDirectory()) throw new Error(missing);
  if (maxstackDriveRoot(final)) {
    throw new Error(`${source} target is a drive root, not a workspace: ${safePath}. Give a folder under it.`);
  }
  if (isMaxstackInternalLocation(final)) {
    throw new Error(
      `${source} target is inside a git directory, a layer checkout, or a layer cache: ${safeName(final)}`,
    );
  }
  assertMaxstackPathText(final, source);
  if (isMaxstackCheckoutLocation(path, repoRoot) || isMaxstackCheckoutLocation(final, repoRoot)) {
    throw new Error(
      `${source} target is a maxstack checkout, not a workspace: ${safePath}. Give the folder of your own workspace.`,
    );
  }
  return path;
}

/** The current directory as the start of a walk, or null when it cannot hold a marker. */
export function maxstackWalkStart(currentDirectory: string): string | null {
  if (/^[\\/]{2}/.test(currentDirectory)) return null;
  try {
    const full = resolve(currentDirectory);
    if (existsSync(full) && statSync(full).isDirectory()) return full;
  } catch {
    return null;
  }
  return null;
}

/** The current directory for a relative user value. */
export function maxstackCurrentDirectory(currentDirectory: string, name: string): string {
  const start = maxstackWalkStart(currentDirectory);
  if (start === null) {
    throw new Error(
      `${name} path is relative, and the current directory cannot resolve it: ${safeName(currentDirectory)}`,
    );
  }
  return start;
}

/** The folder a walk candidate finally names, or null when it cannot be read. */
export function maxstackFinalOrNull(path: string): string | null {
  try {
    return maxstackFinalDirectory(path);
  } catch {
    return null;
  }
}

/** Whether a path is a symbolic link or a junction. */
export function isMaxstackLinkedPath(path: string): boolean {
  return isMaxstackLink(path);
}

/** The nearest folder from the current directory upward that holds a marker file. */
export function findMaxstackCwdMarker(
  currentDirectory: string,
  repoRoot: string | null | undefined,
): { path: string; marker: string } | null {
  let cursor: string | null = resolve(currentDirectory);
  while (cursor !== null) {
    if (maxstackDriveRoot(cursor) || isMaxstackCheckoutLocation(cursor, repoRoot)) {
      cursor = dirname(cursor) === cursor ? null : dirname(cursor);
      continue;
    }
    for (const name of MARKER_NAMES) {
      const marker = joinMaxstackPath(cursor, name);
      if (!existsSync(marker) || !statSync(marker).isFile()) continue;
      if (isMaxstackLinkedPath(marker)) continue;
      const final = maxstackFinalOrNull(cursor);
      if (final !== null && !isMaxstackInternalLocation(final)) {
        return { path: cursor, marker: name };
      }
      break;
    }
    cursor = dirname(cursor) === cursor ? null : dirname(cursor);
  }
  return null;
}

/** The workspace a script's own location names. */
export function maxstackScriptLayoutWorkspace(
  scriptRoot: string,
  repoRoot: string | null | undefined,
): string | null {
  hasNoControlCharacters(scriptRoot, 'Script root');
  let fullScriptRoot: string;
  try {
    fullScriptRoot = resolve(scriptRoot);
  } catch {
    throw new Error(`Script root is invalid: ${safeName(scriptRoot)}`);
  }
  if (basename(fullScriptRoot).toLowerCase() !== 'scripts') return null;
  const repo = dirname(fullScriptRoot);
  const layout = dirname(repo);
  if (!ordinalEqualIgnoreCase(basename(layout), 'repos') && !ordinalEqualIgnoreCase(basename(layout), 'worktrees')) {
    return null;
  }
  const projects = dirname(layout);
  if (basename(projects).toLowerCase() !== 'projects') return null;
  const workspace = dirname(projects);
  if (isMaxstackInternalLocation(workspace)) return null;
  if (isMaxstackCheckoutLocation(workspace, repoRoot)) return null;
  if (maxstackDriveRoot(workspace)) return null;
  return workspace;
}

/** The note when the script layout names a different workspace than the winner. */
export function maxstackLayoutNote(
  scriptRoot: string,
  repoRoot: string | null | undefined,
  target: string,
  origin: string,
): string | null {
  const layout = maxstackScriptLayoutWorkspace(scriptRoot, repoRoot);
  if (layout === null || !existsSync(layout) || !statSync(layout).isDirectory()) return null;
  if (ordinalEqualIgnoreCase(layout, target)) return null;
  return `script layout names ${safeName(layout)}; using ${origin} ${safeName(target)}`;
}

export interface ResolveWorkspaceOptions {
  explicitSpecified?: boolean;
  explicitValue?: string | null;
  currentDirectory?: string;
  scriptRoot?: string;
  platform?: Platform;
  environment?: NodeJS.ProcessEnv;
}

/** Resolves the workspace in the documented order. */
export function resolveMaxstackWorkspace(options: ResolveWorkspaceOptions = {}): WorkspaceResolution {
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const scriptRoot = options.scriptRoot ?? join(process.cwd(), 'scripts');
  const platform = options.platform;
  const repoRoot = maxstackRepoRoot(scriptRoot);
  if (options.explicitSpecified) {
    if (!options.explicitValue || !options.explicitValue.trim()) {
      throw new Error('-Workspace was explicitly supplied but is empty.');
    }
    const target = assertMaxstackWorkspaceTarget(
      maxstackFullPath(options.explicitValue, '-Workspace', currentDirectory, platform),
      '-Workspace',
      repoRoot,
    );
    return { workspace: target, origin: '-Workspace', warning: false, note: null };
  }

  const environment = options.environment ?? process.env;
  const environmentWorkspace = environment.MAXSTACK_WORKSPACE;
  if (environmentWorkspace !== undefined) {
    if (!environmentWorkspace.trim()) throw new Error('MAXSTACK_WORKSPACE is set but empty.');
    const target = assertMaxstackWorkspaceTarget(
      maxstackFullPath(environmentWorkspace, 'MAXSTACK_WORKSPACE', currentDirectory, platform),
      'MAXSTACK_WORKSPACE',
      repoRoot,
    );
    return {
      workspace: target,
      origin: 'MAXSTACK_WORKSPACE',
      warning: false,
      note: maxstackLayoutNote(scriptRoot, repoRoot, target, 'MAXSTACK_WORKSPACE'),
    };
  }

  const walkStart = maxstackWalkStart(currentDirectory);
  const marker = walkStart === null ? null : findMaxstackCwdMarker(walkStart, repoRoot);
  if (marker !== null) {
    const origin = `cwd marker ${marker.marker}`;
    const target = assertMaxstackWorkspaceTarget(marker.path, origin, repoRoot);
    return {
      workspace: target,
      origin,
      warning: false,
      note: maxstackLayoutNote(scriptRoot, repoRoot, target, origin),
    };
  }

  const layoutWorkspace = maxstackScriptLayoutWorkspace(scriptRoot, repoRoot);
  if (layoutWorkspace !== null) {
    assertMaxstackPathText(layoutWorkspace, 'script layout');
    if (existsSync(layoutWorkspace) && statSync(layoutWorkspace).isDirectory()) {
      const target = assertMaxstackWorkspaceTarget(layoutWorkspace, 'script layout', repoRoot);
      return { workspace: target, origin: 'script layout', warning: false, note: null };
    }
  }

  throw new Error(
    'Workspace discovery failed. Name a workspace with -Workspace, MAXSTACK_WORKSPACE, a cwd marker (maxstack.settings.json or stack.lock.json), or the script layout (projects/repos/<repo> or projects/worktrees/<repo>).',
  );
}

export { lstatSync };
