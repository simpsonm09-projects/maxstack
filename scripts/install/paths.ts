// Platform path rules. Text identifiers use ordinal.ts; only filesystem paths use these helpers.
import { relative } from 'node:path';
import { ordinalEqual, ordinalEqualIgnoreCase } from './ordinal.ts';

export type Platform = string | undefined;

/** The platform name, or the host's when none is given. */
export function pathPlatform(platform?: Platform): string {
  if (platform) return platform;
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

function isWindows(platform?: Platform): boolean {
  return ordinalEqualIgnoreCase(pathPlatform(platform), 'Windows');
}

/** Converts a path to the platform's separators. */
export function convertToMaxstackPath(path: string, platform?: Platform): string {
  // PowerShell's [string] parameter turns a null into '', and callers rely on that for a missing field.
  const text = path ?? '';
  return isWindows(platform) ? text.replaceAll('/', '\\') : text;
}

/** Whether a path is absolute for the platform. */
export function maxstackAbsolutePath(path: string, platform?: Platform): boolean {
  if (!(path ?? '')) return false;
  if (isWindows(platform)) return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
  return path.startsWith('/');
}

/** Trims the platform's ending separators, keeping a root. */
export function trimMaxstackPathEndingSeparator(path: string, platform?: Platform): string {
  const platformName = pathPlatform(platform);
  const normalized = convertToMaxstackPath(path ?? '', platformName);
  const trimmed = isWindows(platformName)
    ? normalized.replace(/[\\/]+$/, '')
    : normalized.replace(/\/+$/, '');
  if (!trimmed) return isWindows(platformName) ? '\\' : '/';
  if (isWindows(platformName) && /^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  return trimmed;
}

/** Joins a parent and child, normalizing the child's separators. */
export function joinMaxstackPath(parent: string, child: string, platform?: Platform): string {
  const normalized = convertToMaxstackPath(child ?? '', platform);
  if (maxstackAbsolutePath(normalized, platform)) return normalized;
  const separator = isWindows(platform) ? '\\' : '/';
  const parentPath = trimMaxstackPathEndingSeparator(parent ?? '', platform);
  if (parentPath.endsWith(separator)) return parentPath + normalized;
  return parentPath + separator + normalized;
}

/** Converts a path to the lock's POSIX separators. */
export function convertToMaxstackLockPath(path: string, platform?: Platform): string {
  const text = path ?? '';
  return isWindows(platform) ? text.replaceAll('\\', '/') : text;
}

/** Whether two paths are the same, after trimming ending separators. */
export function maxstackPathEqual(left: string, right: string, platform?: Platform): boolean {
  if (!(left ?? '') || !(right ?? '')) return false;
  const platformName = pathPlatform(platform);
  const normalizedLeft = trimMaxstackPathEndingSeparator(left, platformName);
  const normalizedRight = trimMaxstackPathEndingSeparator(right, platformName);
  return isWindows(platformName)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Whether a child path is inside a parent path. */
export function maxstackPathInside(child: string, parent: string, platform?: Platform): boolean {
  if (!(child ?? '') || !(parent ?? '')) return false;
  const platformName = pathPlatform(platform);
  const separator = isWindows(platformName) ? '\\' : '/';
  const trimmedParent = trimMaxstackPathEndingSeparator(parent, platformName);
  const trimmedChild = trimMaxstackPathEndingSeparator(child, platformName);
  if (maxstackPathEqual(trimmedChild, trimmedParent, platformName)) return true;
  const prefix =
    trimmedParent.endsWith(separator) ||
    (isWindows(platformName) && /^[A-Za-z]:\\$/.test(trimmedParent))
      ? trimmedParent
      : trimmedParent + separator;
  return isWindows(platformName)
    ? trimmedChild.toLowerCase().startsWith(prefix.toLowerCase())
    : trimmedChild.startsWith(prefix);
}

export interface OpenCodePermission {
  resource?: unknown;
  [key: string]: unknown;
}

/** Resolves the workspace placeholders in OpenCode permissions; WSL resources are omitted off Windows. */
export function resolveMaxstackOpenCodePermissions(
  permissions: readonly OpenCodePermission[],
  workspace: string,
  platform?: Platform,
): OpenCodePermission[] {
  const platformName = pathPlatform(platform);
  const workspacePath = convertToMaxstackLockPath(workspace);
  let workspaceWslPath: string | null = null;
  if (isWindows(platformName) && /^[A-Za-z]:[\\/]/.test(workspace)) {
    workspaceWslPath = `/mnt/${workspace.slice(0, 1).toLowerCase()}${workspace.slice(2).replaceAll('\\', '/')}`;
  }
  const result: OpenCodePermission[] = [];
  for (const permission of permissions) {
    const resource = permission.resource;
    if (ordinalEqual(resource, '__MAXSTACK_WORKSPACE__/.opencode/*')) {
      result.push({ ...permission, resource: `${workspacePath}/.opencode/*` });
    } else if (ordinalEqual(resource, '__MAXSTACK_WORKSPACE_WSL__/.opencode/*')) {
      if (workspaceWslPath) {
        result.push({ ...permission, resource: `${workspaceWslPath}/.opencode/*` });
      }
    } else {
      result.push(permission);
    }
  }
  return result;
}

/** The relative path from a base to a target, in lock separators. */
export function maxstackRelativePath(basePath: string, targetPath: string, platform?: Platform): string {
  const platformName = pathPlatform(platform);
  const windows = isWindows(platformName);
  const separator = windows ? '\\' : '/';
  const base = convertToMaxstackPath(basePath, platformName);
  const target = convertToMaxstackPath(targetPath, platformName);
  if (!maxstackAbsolutePath(base, platformName) || !maxstackAbsolutePath(target, platformName)) {
    return convertToMaxstackLockPath(relative(basePath, targetPath), platformName);
  }
  if (windows) {
    const rootPattern = /^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)/;
    const baseRoot = rootPattern.exec(base)?.[0] ?? '';
    const targetRoot = rootPattern.exec(target)?.[0] ?? '';
    if (baseRoot.toLowerCase() !== targetRoot.toLowerCase()) {
      return convertToMaxstackLockPath(target);
    }
  }
  const split = (value: string) => value.split(separator).filter(Boolean);
  const baseParts = split(base);
  const targetParts = split(target);
  const same = windows
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;
  let common = 0;
  while (
    common < baseParts.length &&
    common < targetParts.length &&
    same(baseParts[common] as string, targetParts[common] as string)
  ) {
    common++;
  }
  const relativeParts: string[] = [];
  for (let index = common; index < baseParts.length; index++) relativeParts.push('..');
  for (let index = common; index < targetParts.length; index++) {
    relativeParts.push(targetParts[index] as string);
  }
  return relativeParts.join('/');
}
