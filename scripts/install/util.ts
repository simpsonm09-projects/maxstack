// Shared filesystem, hash, JSON, and output helpers for the TypeScript installer.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { safeName } from './ordinal.ts';

/** The uppercase SHA-256 of a text's UTF-8 bytes, as Get-FileHash prints it. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').toUpperCase();
}

/** The uppercase SHA-256 of a file. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

/** The SHA-256 of a file, or null when it is absent or not a regular file. */
export function sha256FileOrNull(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return sha256File(path);
  } catch {
    return null;
  }
}

/** Reads a UTF-8 text, stripping a byte-order mark. */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

/** Writes a UTF-8 text with no byte-order mark. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Writes text through a temporary file, so an interrupted write leaves the old file whole. */
export function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.maxstack-tmp`;
  const old = `${path}.maxstack-old`;
  try {
    writeText(temp, text);
    if (existsSync(path)) {
      if (existsSync(old)) rmSync(old, { force: true });
      renameSync(temp, path);
      if (existsSync(old)) rmSync(old, { force: true });
    } else {
      renameSync(temp, path);
    }
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Throws when a file's bytes changed since the plan. */
export function assertUnchangedSince(path: string, plannedSha: string | null): void {
  if (sha256FileOrNull(path) !== plannedSha) {
    throw new Error(
      `${path} changed after the install planned its text, so nothing was written to it. Rerun -Apply.`,
    );
  }
}

/** A case-sensitive field read from an object, or null. */
export function getField(value: unknown, name: string): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return Object.hasOwn(value as object, name) ? (value as Record<string, unknown>)[name] : null;
}

/** Whether an object holds a field. */
export function hasField(value: unknown, name: string): boolean {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value as object, name)
  );
}

/** Writes a line to standard output, as Write-Host does. */
export function writeHost(...parts: unknown[]): void {
  process.stdout.write(`${parts.map((part) => String(part)).join(' ')}\n`);
}

/** Writes a warning to standard error, as Write-Warning does. */
export function writeWarning(message: string): void {
  // PowerShell's warning stream reaches stdout when the host's output is captured, so a warning stays in the same
  // place the tests compare it in.
  process.stdout.write(`WARNING: ${message}\n`);
}

/** Formats a value for a message. */
export function show(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Whether a path exists (a link counts even when its target is missing). */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether a path is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path is a regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The entries of a folder, optionally filtered by a suffix or name pattern. */
export function listDir(path: string): string[] {
  return readdirSync(path);
}

/** Deletes a file or a tree. A link is removed as a link, so its target is never touched. */
export function removeTree(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    rmSync(path, { force: true });
    return;
  }
  if (stats.isDirectory()) {
    for (const child of readdirSync(path)) removeTree(join(path, child));
    rmSync(path, { recursive: false, force: true });
  } else {
    try {
      writeFileSync(path, readFileSync(path));
    } catch {
      // A read-only file is made writable by the remove below.
    }
    rmSync(path, { force: true });
  }
}

/** Copies a file or tree, keeping links as links. */
export function copyTree(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    const { readlinkSync, symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of readdirSync(source)) copyTree(join(source, child), join(destination, child));
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

/** The safe display of a path. */
export function display(value: unknown): string {
  return safeName(value === null || value === undefined ? '' : String(value));
}
