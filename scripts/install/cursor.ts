// Cursor Agent Skills are copied by skill folder into the project root's .cursor/skills folder.
// Each folder is recorded as one owned path so apply, status, remove, and uninstall use the common lock lifecycle.
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isTrue, ordinalEqual, ordinalEqualIgnoreCase } from './ordinal.ts';
import { convertToMaxstackPath, joinMaxstackPath } from './paths.ts';
import { getField, isDirectory, pathExists, writeHost } from './util.ts';
import { S, type OwnedRecord } from './state.ts';
import type { LayerModel } from './layer-sources.ts';
import { copySkillTree, getHookConfigPlan, type HookConfigPlan, type SkillEntry } from './codex.ts';
import { getTreeSha256, removeOwnedTree, testReparsePoint } from './tree.ts';

export const CURSOR_SKILL_FOLDER = '.cursor/skills';
// The Cursor hook: a version-1 .cursor/hooks.json whose beforeShellExecution command runs the installed adapter.
export const CURSOR_HOOK_CONFIG_PATH = '.cursor/hooks.json';
export const CURSOR_HOOK_DEFINITION = 'hooks/cursor-hooks.json';

export function getCursorRecord(owned: readonly (OwnedRecord | null)[], rel: string): OwnedRecord | null {
  return (
    owned.find(
      (record) =>
        record !== null &&
        ordinalEqual(record.path, rel) &&
        ordinalEqual(record.kind, 'dir') &&
        ordinalEqual(getField(record, 'runtime'), 'cursor'),
    ) ?? null
  );
}

export function assertCursorSkillsPath(): void {
  const cursor = joinMaxstackPath(S.workspace, '.cursor');
  const root = joinMaxstackPath(S.workspace, convertToMaxstackPath(CURSOR_SKILL_FOLDER));
  for (const path of [cursor, root]) {
    if (!pathExists(path)) continue;
    if (testReparsePoint(path)) {
      throw new Error(`Cursor target '${path}' is a link or reparse point, so nothing was written.`);
    }
    if (!isDirectory(path)) {
      throw new Error(`Cursor target '${path}' exists and is not a directory, so nothing was written.`);
    }
  }
}

export function assertCursorDestinationWithinWorkspace(path: string): void {
  const workspaceFull = resolve(S.workspace).replace(/[\\/]+$/, '');
  const targetFull = resolve(path);
  const prefix = `${workspaceFull}/`;
  if (!targetFull.replaceAll('\\', '/').startsWith(prefix)) {
    throw new Error(`Cursor target '${targetFull}' resolves outside the workspace, so nothing was written.`);
  }
  const rel = relative(workspaceFull, targetFull);
  let current = workspaceFull;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (pathExists(current) && testReparsePoint(current)) {
      throw new Error(`Cursor target '${current}' is a link or reparse point, so nothing was written.`);
    }
  }
}

export function assertCursorSkillName(name: string): void {
  if (
    name.length === 0 ||
    ordinalEqual(name, '.') ||
    ordinalEqual(name, '..') ||
    /[/\\<>:"|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /[\x00-\x1f]/.test(name)
  ) {
    throw new Error(`Cursor skill folder '${name}' is not a safe path segment, so nothing was written.`);
  }
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(name)) {
    throw new Error(`Cursor skill folder '${name}' is a reserved Windows device name, so nothing was written.`);
  }
}

export function assertCursorSkillTargets(
  skills: SkillEntry[],
  owned: readonly (OwnedRecord | null)[] | null,
): void {
  const root = joinMaxstackPath(S.workspace, convertToMaxstackPath(CURSOR_SKILL_FOLDER));
  assertCursorSkillsPath();
  for (const skill of skills) {
    assertCursorSkillName(skill.name);
  }
  for (const record of owned ?? []) {
    if (record === null) continue;
    if (!ordinalEqual(getField(record, 'runtime'), 'cursor') || !ordinalEqual(record.kind, 'dir')) continue;
    const rel = record.path.replaceAll('\\', '/');
    const prefix = `${CURSOR_SKILL_FOLDER}/`;
    if (!rel.startsWith(prefix)) {
      throw new Error(
        `Cursor ownership path '${record.path}' is outside ${CURSOR_SKILL_FOLDER}, so nothing was written.`,
      );
    }
    const name = rel.slice(prefix.length);
    assertCursorSkillName(name);
    const full = joinMaxstackPath(S.workspace, convertToMaxstackPath(record.path));
    assertCursorDestinationWithinWorkspace(full);
  }
  if (!isDirectory(root)) return;
  const existing = readdirSync(root);
  for (const skill of skills) {
    const same = existing.filter((name) => ordinalEqualIgnoreCase(name, skill.name));
    if (same.length === 0) continue;
    const rel = `${CURSOR_SKILL_FOLDER}/${same[0]}`;
    const path = joinMaxstackPath(S.workspace, convertToMaxstackPath(rel));
    assertCursorDestinationWithinWorkspace(path);
    if (testReparsePoint(path)) {
      throw new Error(`Cursor target '${path}' is a link or reparse point, so nothing was written.`);
    }
    const record = getCursorRecord(owned ?? [], rel);
    if (record === null) {
      throw new Error(
        `${rel} already exists and maxstack did not write it, so nothing was written. Move it aside, then rerun -Apply.`,
      );
    }
    if (!isDirectory(path)) {
      throw new Error(
        `${rel} exists as a file, not an owned skill directory, so nothing was written. Move it aside, then rerun -Apply.`,
      );
    }
    if (!ordinalEqual(same[0], skill.name)) {
      throw new Error(
        `${rel} collides with cursor skill '${skill.name}' by case, so nothing was written. Rename one of the skills.`,
      );
    }
    if (!ordinalEqual(getTreeSha256(path), record.sha256)) {
      writeHost(`Kept ${rel}: it changed since the last apply.`);
      skill.preserve = true;
      skill.prior = record;
    }
  }
}

export function writeCursorSkills(
  skills: readonly SkillEntry[],
  owned: readonly (OwnedRecord | null)[] | null,
  removeStale = true,
): void {
  const wanted = skills.map((skill) => `${CURSOR_SKILL_FOLDER}/${skill.name}`);
  if (removeStale) {
    for (const record of owned ?? []) {
      if (record === null) continue;
      if (!ordinalEqual(getField(record, 'runtime'), 'cursor') || !ordinalEqual(record.kind, 'dir')) continue;
      if (wanted.some((path) => ordinalEqual(record.path, path))) continue;
      const full = joinMaxstackPath(S.workspace, convertToMaxstackPath(record.path));
      assertCursorDestinationWithinWorkspace(full);
      if (testReparsePoint(full)) {
        writeHost(`Kept ${record.path}: it is a link or reparse point`);
        continue;
      }
      if (!isDirectory(full)) continue;
      if (!ordinalEqual(getTreeSha256(full), record.sha256)) {
        writeHost(`Kept ${record.path}: it changed since the last apply, and no layer ships it now`);
        continue;
      }
      removeOwnedTree(full);
      writeHost(`Removed the cursor skill ${record.path}: no layer ships it now`);
    }
  }
  for (const skill of skills) {
    if (isTrue(skill.preserve)) continue;
    const full = joinMaxstackPath(S.workspace, convertToMaxstackPath(`${CURSOR_SKILL_FOLDER}/${skill.name}`));
    assertCursorDestinationWithinWorkspace(full);
    removeOwnedTree(full);
    copySkillTree(skill.source, full);
    writeHost(`Copied cursor skill '${skill.name}' from layer '${skill.layer}' into ${full}`);
  }
}

/** The Cursor hook plan, owned like the Codex config: a changed copy or one maxstack did not write is kept. */
export function getCursorHookConfigPlan(
  layers: readonly LayerModel[],
  openCodeSelected: boolean,
  claudeSelected: boolean,
): HookConfigPlan | null {
  return getHookConfigPlan({
    layers,
    runtime: 'cursor',
    relative: CURSOR_HOOK_CONFIG_PATH,
    definition: CURSOR_HOOK_DEFINITION,
    label: 'Cursor',
    openCodeSelected,
    claudeSelected,
  });
}
