// Filesystem link policy. Link paths are inspected and removed without walking into their targets.
import {
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ordinalIn } from './ordinal.ts';
import {
  convertToMaxstackPath,
  joinMaxstackPath,
  maxstackAbsolutePath,
  maxstackPathEqual,
  pathPlatform,
  trimMaxstackPathEndingSeparator,
  type Platform,
} from './paths.ts';

/** The link record kind the platform writes. */
export function linkRecordKind(platform?: Platform): string {
  return pathPlatform(platform).toLowerCase() === 'windows' ? 'junction' : 'symlink';
}

/** Whether a kind names a link record. */
export function isLinkRecordKind(kind: unknown): boolean {
  return ordinalIn(kind, ['junction', 'symlink']);
}

/** The link kind of a path, or null when it is not a link. */
export function maxstackLinkKind(path: string, platform?: Platform): string | null {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      if (pathPlatform(platform).toLowerCase() === 'windows') {
        // Node reports junctions as symbolic links with a directory target.
        try {
          const target = readlinkSync(path);
          const stat = statSync(path);
          if (stat.isDirectory() && (target.startsWith('\\\\?\\') || target.startsWith('\\??\\'))) {
            return 'junction';
          }
        } catch {
          return 'symlink';
        }
        return 'symlink';
      }
      return 'symlink';
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether a path is a link. */
export function isMaxstackLink(path: string, platform?: Platform): boolean {
  return maxstackLinkKind(path, platform) !== null;
}

/** The target a link names, without a Windows \\?\ or \??\ prefix. */
export function maxstackLinkTarget(path: string): string {
  const target = readlinkSync(path);
  let text = target;
  for (const prefix of ['\\\\?\\', '\\??\\']) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }
  return trimMaxstackPathEndingSeparator(text);
}

/** Whether a link names a target. */
export function maxstackLinkTargetMatches(
  path: string,
  target: string,
  kind = '',
  platform?: Platform,
): boolean {
  if (!isMaxstackLink(path, platform)) return false;
  if (kind && maxstackLinkKind(path, platform) !== kind) return false;
  let linked = maxstackLinkTarget(path);
  if (!linked) return false;
  const pathPlatformName = pathPlatform();
  if (!maxstackAbsolutePath(linked, pathPlatformName)) {
    linked = joinMaxstackPath(dirname(resolve(path)), linked, pathPlatformName);
  }
  let expectedPath = target;
  for (const prefix of ['\\\\?\\', '\\??\\']) {
    if (expectedPath.startsWith(prefix)) expectedPath = expectedPath.slice(prefix.length);
  }
  const expected = resolve(convertToMaxstackPath(expectedPath, pathPlatformName));
  const actual = resolve(convertToMaxstackPath(linked, pathPlatformName));
  return maxstackPathEqual(actual, expected, pathPlatformName);
}

/** Creates a directory link: a junction on Windows, a symbolic link elsewhere. */
export function createMaxstackDirectoryLink(
  path: string,
  target: string,
  platform?: Platform,
): void {
  const type = pathPlatform(platform).toLowerCase() === 'windows' ? 'junction' : 'dir';
  symlinkSync(target, path, type);
}

/** Removes a link without touching its target. */
export function removeMaxstackLink(path: string, platform?: Platform): void {
  if (!isMaxstackLink(path, platform)) return;
  rmSync(path, { force: false });
}

export { existsSync, isAbsolute };
